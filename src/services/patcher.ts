import fs from 'fs/promises';
import path from 'path';
import { ManifestImage } from '../types/index.js';
import { updateImage, tarFilename, ensureImagesDir } from './manifest.js';
import { pullImage, runTrivy, saveImageAsTar, removeLocalImage } from './docker.js';
import { patchWithCopa } from './copa.js';
import logger from '../logger.js';

export async function patchImage(image: ManifestImage): Promise<ManifestImage> {
  await ensureImagesDir();

  const set = (status: ManifestImage['status']): ManifestImage => {
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

    // 3. Patch
    await updateImage(set('patching'));
    const { patchedRef, fullyPatched } = await patchWithCopa(image, reportPath);

    // 4. Save tar
    const tarPath = tarFilename(image);
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
      tarPath: `images/${path.basename(tarPath)}`,
      lastScanned: now,
      lastPatched: now,
      vulnerabilities,
    };
    logger.info('Patch cycle complete', {
      image: `${image.registry}/${image.name}:${image.tag}`,
      status: image.status,
      vulnerabilities: image.vulnerabilities,
      tarPath: image.tarPath,
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
