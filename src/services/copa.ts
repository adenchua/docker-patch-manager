import { execFile } from 'child_process';
import { promisify } from 'util';
import { Image } from '../types/index.js';
import { createLogger } from '../logger.js';

const logger = createLogger('copa');

const execFileAsync = promisify(execFile);

const COPA_TIMEOUT = process.env.COPA_TIMEOUT ?? '10m';

// Schemes accepted by buildkit client connhelpers plus copa's buildx helper.
// `\S*` (not `\S+`): `buildx://` with no builder name is valid (current builder).
const BUILDKIT_ADDR_RE = /^(tcp|unix|docker-container|kube-pod|podman-container|nerdctl-container|ssh|buildx):\/\/\S*$/;

// Validated at module load so a bad value aborts startup instead of failing on the first patch.
function resolveBuildkitAddr(): string | undefined {
  const raw = process.env.COPA_BUILDKIT_ADDR;
  if (raw === undefined || raw.trim() === '') return undefined;
  const addr = raw.trim();
  if (!BUILDKIT_ADDR_RE.test(addr)) {
    throw new Error(
      `Invalid COPA_BUILDKIT_ADDR "${raw}": expected <scheme>://<address> with scheme one of ` +
        'tcp, unix, docker-container, kube-pod, podman-container, nerdctl-container, ssh, buildx'
    );
  }
  return addr;
}

const COPA_BUILDKIT_ADDR = resolveBuildkitAddr();

export interface CopaResult {
  patchedRef: string;
  fullyPatched: boolean;
}

export async function patchWithCopa(image: Image, trivyReportPath: string): Promise<CopaResult> {
  const sourceRef = `${image.registry}/${image.name}:${image.tag}`;
  const patchedTag = image.tag;
  const patchedRef = `${image.registry}/${image.name}:${patchedTag}`;

  logger.info('Copa patch started', { source: sourceRef, target: patchedRef });
  const copaStart = Date.now();

  const copaArgs = [
    'patch',
    '-i',
    sourceRef,
    '-r',
    trivyReportPath,
    '-t',
    patchedTag,
    '--timeout',
    COPA_TIMEOUT,
    '--platform',
    image.architecture,
  ];
  if (COPA_BUILDKIT_ADDR) copaArgs.push('--addr', COPA_BUILDKIT_ADDR);

  try {
    await execFileAsync('copa', copaArgs);
    logger.info('Copa patch complete', { patchedRef, durationMs: Date.now() - copaStart });
    return { patchedRef, fullyPatched: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Copa exits non-zero when there are no OS-level vulns to patch (only language-level remain)
    if (message.includes('no patchable vulnerabilities') || message.includes('no updates needed')) {
      logger.warn('Copa: no patchable vulnerabilities, image unchanged', {
        source: sourceRef,
        reason: message,
        durationMs: Date.now() - copaStart,
      });
      return { patchedRef: sourceRef, fullyPatched: false };
    }

    if (
      message.includes('Operation Timed Out') ||
      message.includes('patch exceeded timeout') ||
      message.includes('context canceled')
    ) {
      logger.error('Copa patch timed out', {
        source: sourceRef,
        timeout: COPA_TIMEOUT,
        durationMs: Date.now() - copaStart,
      });
      throw new Error(`Copa timed out (${COPA_TIMEOUT}) for ${sourceRef}`);
    }

    logger.error('Copa patch failed', { source: sourceRef, err: message });
    throw err;
  }
}
