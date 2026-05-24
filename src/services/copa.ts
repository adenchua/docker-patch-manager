import { execFile } from 'child_process';
import { promisify } from 'util';
import { ManifestImage } from '../types/index.js';
import logger from '../logger.js';

const execFileAsync = promisify(execFile);

export interface CopaResult {
  patchedRef: string;
  fullyPatched: boolean;
}

export async function patchWithCopa(image: ManifestImage, trivyReportPath: string): Promise<CopaResult> {
  const sourceRef = `${image.registry}/${image.name}:${image.tag}`;
  const patchedTag = `${image.tag}-patched`;
  const patchedRef = `${image.registry}/${image.name}:${patchedTag}`;

  logger.info('Copa patch started', { source: sourceRef, target: patchedRef });
  const copaStart = Date.now();

  try {
    await execFileAsync('copa', ['patch', '-i', sourceRef, '-r', trivyReportPath, '-t', patchedTag]);
    logger.info('Copa patch complete', { patchedRef, durationMs: Date.now() - copaStart });
    return { patchedRef, fullyPatched: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Copa exits non-zero when there are no OS-level vulns to patch (only language-level remain)
    if (message.includes('no patchable vulnerabilities') || message.includes('no updates needed')) {
      logger.warn('Copa: no patchable vulnerabilities, image unchanged', { source: sourceRef, reason: message, durationMs: Date.now() - copaStart });
      return { patchedRef: sourceRef, fullyPatched: false };
    }

    logger.error('Copa patch failed', { source: sourceRef, err: message });
    throw err;
  }
}
