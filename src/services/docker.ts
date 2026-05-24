import { execFile } from 'child_process';
import { promisify } from 'util';
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

  await new Promise<void>((resolve, reject) => {
    const { exec } = require('child_process');
    const cmd = `docker save "${imageRef}" | gzip > "${destPath}"`;
    exec(cmd, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

export async function removeLocalImage(imageRef: string): Promise<void> {
  try {
    await execFileAsync('docker', ['rmi', '--force', imageRef]);
  } catch {
    // best-effort cleanup
  }
}
