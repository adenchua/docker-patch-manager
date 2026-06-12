import fs from 'fs/promises';
import { Image } from '../types/index.js';
import { updateImage, outputPath, ensureOutputDir, removeImageById } from './database.js';
import { pullImage, runTrivy, runTrivyOnRef, saveImageAsTar, removeLocalImage } from './docker.js';
import { patchWithCopa } from './copa.js';
import { createLogger } from '../logger.js';

const logger = createLogger('patcher');

const activePatches = new Set<number>();

export async function patchImage(image: Image): Promise<Image> {
  const id = image.id!;
  if (activePatches.has(id)) {
    throw new Error(`Already patching image ${id}`);
  }
  activePatches.add(id);

  const set = (status: Image['status']): Image => {
    image = { ...image, status };
    return image;
  };

  try {
    await ensureOutputDir(image);
    // 1. Download
    await updateImage(set('downloading'));
    logger.info('Pulling image', { image: `${image.registry}/${image.name}:${image.tag}` });
    await pullImage(image);

    // 2. Scan
    await updateImage(set('scanning'));
    const { vulnerabilities, reportPath, hasOsPackageTypes, hasOsVulns } = await runTrivy(image);

    // Persist scan results now — Copa may fail but scan data is still valuable
    const scannedAt = new Date().toISOString();
    image = { ...image, lastScanned: scannedAt, vulnerabilities };
    await updateImage(image);

    // 3. Gate: decide whether to invoke Copa based on Trivy patchability data
    let patchedRef: string;
    let fullyPatched: boolean;
    let patchReason: Image['patchReason'] = null;

    if (!hasOsPackageTypes) {
      // No dpkg/rpm/apk result types — image is app-layer-only (distroless/scratch); Copa cannot help
      patchedRef = `${image.registry}/${image.name}:${image.tag}`;
      fullyPatched = false;
      patchReason = 'app-layer-only';
      logger.info('Skipping Copa: no OS package types in Trivy report (distroless/scratch/app-layer-only)', {
        image: `${image.registry}/${image.name}:${image.tag}`,
      });
    } else if (!hasOsVulns) {
      // OS package DB present but no OS-level CVEs — Copa would find nothing to patch
      patchedRef = `${image.registry}/${image.name}:${image.tag}`;
      fullyPatched = false;
      patchReason = 'no-os-vulns';
      logger.info('Skipping Copa: OS packages present but no OS-level vulnerabilities', {
        image: `${image.registry}/${image.name}:${image.tag}`,
      });
    } else {
      // OS-level CVEs found — invoke Copa (handles both regular and distroless DPKG/RPM images)
      await updateImage(set('patching'));
      const copaResult = await patchWithCopa(image, reportPath);
      patchedRef = copaResult.patchedRef;
      fullyPatched = copaResult.fullyPatched;
      if (!fullyPatched) patchReason = 'copa-no-updates';
    }

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
      patchReason,
    };
    logger.info('Patch cycle complete', {
      image: `${image.registry}/${image.name}:${image.tag}`,
      status: image.status,
      vulnerabilities: image.vulnerabilities,
    });
    await updateImage(image);
    return image;
  } catch (err) {
    if (String(err).includes('application/vnd.cncf.notary.signature')) {
      logger.warn('Image resolves to an OCI notary signature, not a container image — removing from database', {
        image: `${image.registry}/${image.name}:${image.tag}`,
      });
      await removeImageById(id).catch((dbErr) =>
        logger.error('Failed to remove incompatible image', { err: String(dbErr) })
      );
      return image;
    }
    logger.error('Patch cycle failed', { image: `${image.registry}/${image.name}:${image.tag}`, err: String(err) });
    image = { ...image, status: 'failed' };
    await updateImage(image).catch((dbErr) => logger.error('Failed to persist failed status', { err: String(dbErr) }));
    throw err;
  } finally {
    activePatches.delete(id);
  }
}
