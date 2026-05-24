import fs from 'fs/promises';
import { Image } from '../types/index.js';
import { updateImage, outputPath, ensureOutputDir } from './database.js';
import { pullImage, runTrivy, runTrivyOnRef, saveImageAsTar, removeLocalImage } from './docker.js';
import { patchWithCopa } from './copa.js';
import logger from '../logger.js';

export async function patchImage(image: Image): Promise<Image> {
  await ensureOutputDir(image);

  const set = (status: Image['status']): Image => {
    image = { ...image, status };
    return image;
  };

  try {
    // 1. Download
    await updateImage(set('downloading'));
    logger.info('Pulling image', { image: `${image.registry}/${image.name}:${image.tag}` });
    await pullImage(image);

    // 2. Scan
    await updateImage(set('scanning'));
    const { vulnerabilities, reportPath } = await runTrivy(image);

    // Persist scan results now — Copa may fail but scan data is still valuable
    const scannedAt = new Date().toISOString();
    image = { ...image, lastScanned: scannedAt, vulnerabilities };
    await updateImage(image);

    // 3. Patch
    await updateImage(set('patching'));
    const { patchedRef, fullyPatched } = await patchWithCopa(image, reportPath);

    // 3b. Re-scan patched image to reflect updated vulnerability counts
    if (fullyPatched) {
      try {
        const patchedVulnerabilities = await runTrivyOnRef(patchedRef);
        image = { ...image, vulnerabilities: patchedVulnerabilities, lastScanned: new Date().toISOString() };
        await updateImage(image);
      } catch (err) {
        logger.warn('Post-patch Trivy scan failed — keeping pre-patch counts', { image: patchedRef, err: String(err) });
      }
    }

    // 4. Save tar
    const tarPath = outputPath(image);
    await saveImageAsTar(patchedRef, tarPath);

    // 5. Cleanup tmp report and local images
    await fs.unlink(reportPath).catch(() => {});
    await removeLocalImage(patchedRef);
    if (fullyPatched) {
      await removeLocalImage(`${image.registry}/${image.name}:${image.tag}`);
    }

    const now = new Date().toISOString();
    image = {
      ...image,
      status: fullyPatched ? 'ready' : 'ready-unpatched',
      lastPatched: now,
    };
    logger.info('Patch cycle complete', {
      image: `${image.registry}/${image.name}:${image.tag}`,
      status: image.status,
      vulnerabilities: image.vulnerabilities,
    });
    await updateImage(image);
    return image;
  } catch (err) {
    logger.error('Patch cycle failed', { image: `${image.registry}/${image.name}:${image.tag}`, err: String(err) });
    image = { ...image, status: 'failed' };
    await updateImage(image);
    throw err;
  }
}
