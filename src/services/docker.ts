import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import { createGzip } from 'zlib';
import { createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { ManifestImage, VulnerabilityCounts } from '../types/index.js';

const execFileAsync = promisify(execFile);

export async function pullImage(image: ManifestImage): Promise<void> {
  const ref = `${image.registry}/${image.name}:${image.tag}`;
  await execFileAsync('docker', ['pull', '--platform', image.architecture, ref]);
}

export interface TrivyResult {
  vulnerabilities: VulnerabilityCounts;
  reportPath: string;
}

export async function runTrivy(image: ManifestImage): Promise<TrivyResult> {
  const ref = `${image.registry}/${image.name}:${image.tag}`;
  const reportPath = path.join(os.tmpdir(), `trivy-${image.name.replace(/\//g, '_')}-${image.tag}.json`);

  await execFileAsync('docker', [
    'run',
    '--rm',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${os.tmpdir()}:/tmp`,
    'aquasec/trivy',
    'image',
    '--format',
    'json',
    '--output',
    `/tmp/${path.basename(reportPath)}`,
    ref,
  ]);

  const raw = await fs.readFile(reportPath, 'utf-8');
  const report = JSON.parse(raw);

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

  return { vulnerabilities: counts, reportPath };
}

export async function saveImageAsTar(imageRef: string, destPath: string): Promise<void> {
  const dir = path.dirname(destPath);
  await fs.mkdir(dir, { recursive: true });

  const dockerSave = spawn('docker', ['save', imageRef], { stdio: ['ignore', 'pipe', 'pipe'] });
  const gzip = createGzip();
  const out = createWriteStream(destPath);

  const stderrChunks: Buffer[] = [];
  dockerSave.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  try {
    await pipeline(dockerSave.stdout, gzip, out);
  } catch (err) {
    await fs.unlink(destPath).catch(() => {});
    const stderrText = Buffer.concat(stderrChunks).toString().trim();
    throw new Error(`docker save failed for "${imageRef}": ${stderrText || String(err)}`);
  }

  await new Promise<void>((resolve, reject) => {
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
}

export async function removeLocalImage(imageRef: string): Promise<void> {
  try {
    await execFileAsync('docker', ['rmi', '--force', imageRef]);
  } catch {
    // best-effort cleanup
  }
}
