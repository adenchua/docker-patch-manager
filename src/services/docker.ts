import { execFile, spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import { createGzip } from 'zlib';
import { createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { Image, VulnerabilityCounts } from '../types/index.js';
import { createLogger } from '../logger.js';

const logger = createLogger('docker');

const execFileAsync = promisify(execFile);

// Pinned scanner image (supply-chain reproducibility); the CVE database itself
// is still fetched fresh at scan time. `||` so an empty env var falls back.
const TRIVY_IMAGE = process.env.TRIVY_IMAGE?.trim() || 'aquasec/trivy:0.71.0';
// Daemon-side named volume persisting the Trivy vuln DB across ephemeral scan containers.
const TRIVY_CACHE_VOLUME = process.env.TRIVY_CACHE_VOLUME?.trim() || 'trivy-db-cache';

export async function pullImage(image: Image): Promise<void> {
  const ref = `${image.registry}/${image.name}:${image.tag}`;
  await execFileAsync('docker', ['pull', '--platform', image.architecture, ref]);
}

export interface TrivyResult {
  vulnerabilities: VulnerabilityCounts;
  reportPath: string;
  hasOsPackageTypes: boolean; // true if any result has Class === 'os-pkgs'
  hasOsVulns: boolean; // true if any os-pkgs result has ≥1 vulnerability
}

export async function runTrivy(image: Image): Promise<TrivyResult> {
  const ref = `${image.registry}/${image.name}:${image.tag}`;
  // Registry + random suffix keep concurrent scans of the same name:tag from clobbering each other.
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_');
  const reportPath = path.join(
    os.tmpdir(),
    `trivy-${safe(image.registry)}-${safe(image.name)}-${safe(image.tag)}-${randomUUID()}.json`
  );

  logger.info('Trivy scan started', { image: ref });
  const trivyStart = Date.now();

  const { stdout } = await execFileAsync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      `${TRIVY_CACHE_VOLUME}:/root/.cache/trivy`,
      TRIVY_IMAGE,
      'image',
      '--format',
      'json',
      '--list-all-pkgs',
      ref,
    ],
    { maxBuffer: 50 * 1024 * 1024 }
  );

  await fs.writeFile(reportPath, stdout, 'utf-8');
  const report = JSON.parse(stdout);

  const counts: VulnerabilityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  let hasOsPackageTypes = false;
  let hasOsVulns = false;

  for (const result of report.Results ?? []) {
    const isOsType = result.Class === 'os-pkgs';
    if (isOsType) hasOsPackageTypes = true;

    for (const vuln of result.Vulnerabilities ?? []) {
      const sev = (vuln.Severity as string).toLowerCase();
      if (sev === 'critical') counts.critical++;
      else if (sev === 'high') counts.high++;
      else if (sev === 'medium') counts.medium++;
      else if (sev === 'low') counts.low++;

      if (isOsType) hasOsVulns = true;
    }
  }

  logger.info('Trivy scan complete', {
    image: ref,
    vulnerabilities: counts,
    hasOsPackageTypes,
    hasOsVulns,
    durationMs: Date.now() - trivyStart,
  });

  return { vulnerabilities: counts, reportPath, hasOsPackageTypes, hasOsVulns };
}

export async function runTrivyOnRef(imageRef: string): Promise<VulnerabilityCounts> {
  logger.info('Trivy post-patch scan started', { image: imageRef });
  const start = Date.now();

  const { stdout } = await execFileAsync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      `${TRIVY_CACHE_VOLUME}:/root/.cache/trivy`,
      TRIVY_IMAGE,
      'image',
      '--format',
      'json',
      imageRef,
    ],
    { maxBuffer: 50 * 1024 * 1024 }
  );

  const report = JSON.parse(stdout);
  const counts: VulnerabilityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const result of report.Results ?? []) {
    for (const vuln of result.Vulnerabilities ?? []) {
      const sev = (vuln.Severity as string).toLowerCase();
      if (sev === 'critical') counts.critical++;
      else if (sev === 'high') counts.high++;
      else if (sev === 'medium') counts.medium++;
      else if (sev === 'low') counts.low++;
    }
  }

  logger.info('Trivy post-patch scan complete', {
    image: imageRef,
    vulnerabilities: counts,
    durationMs: Date.now() - start,
  });
  return counts;
}

export async function saveImageAsTar(imageRef: string, destPath: string): Promise<void> {
  const dir = path.dirname(destPath);
  await fs.mkdir(dir, { recursive: true });

  const dockerSave = spawn('docker', ['save', imageRef], { stdio: ['ignore', 'pipe', 'pipe'] });
  const gzip = createGzip();
  const out = createWriteStream(destPath);

  const stderrChunks: Buffer[] = [];
  dockerSave.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  // Register before pipeline: ChildProcess emits 'close' via process.nextTick, which runs
  // before Promise microtasks, so registering after `await pipeline` would miss the event.
  const closePromise = new Promise<void>((resolve, reject) => {
    dockerSave.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const stderrText = Buffer.concat(stderrChunks).toString().trim();
        fs.unlink(destPath).catch(() => {});
        reject(new Error(`docker save exited with code ${code}: ${stderrText}`));
      }
    });
    dockerSave.on('error', reject);
  });

  try {
    await pipeline(dockerSave.stdout, gzip, out);
  } catch (err) {
    closePromise.catch(() => {});
    dockerSave.kill();
    await fs.unlink(destPath).catch(() => {});
    const stderrText = Buffer.concat(stderrChunks).toString().trim();
    throw new Error(`docker save failed for "${imageRef}": ${stderrText || String(err)}`);
  }

  await closePromise;
}

export async function removeLocalImage(imageRef: string): Promise<void> {
  try {
    await execFileAsync('docker', ['rmi', '--force', imageRef]);
  } catch {
    // best-effort cleanup
  }
}
