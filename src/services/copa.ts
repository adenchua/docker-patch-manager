import { execFile } from 'child_process';
import { promisify } from 'util';
import { ManifestImage } from '../types/index.js';

const execFileAsync = promisify(execFile);

export interface CopaResult {
  patchedRef: string;
  fullyPatched: boolean;
}

export async function patchWithCopa(image: ManifestImage, trivyReportPath: string): Promise<CopaResult> {
  const sourceRef = `${image.registry}/${image.name}:${image.tag}`;
  const patchedTag = `${image.tag}-patched`;
  const patchedRef = `${image.registry}/${image.name}:${patchedTag}`;

  try {
    await execFileAsync('copa', ['patch', '-i', sourceRef, '-r', trivyReportPath, '-t', patchedTag]);
    return { patchedRef, fullyPatched: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Copa exits non-zero when there are no OS-level vulns to patch (only language-level remain)
    if (message.includes('no patchable vulnerabilities') || message.includes('no updates needed')) {
      return { patchedRef: sourceRef, fullyPatched: false };
    }

    throw err;
  }
}
