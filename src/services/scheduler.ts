import cron from 'node-cron';
import pLimit from 'p-limit';
import { readManifest } from './manifest.js';
import { patchImage } from './patcher.js';
import { JobStatus, LastRunSummary } from '../types/index.js';

const PATCH_SCHEDULE = process.env.PATCH_SCHEDULE ?? '0 2 * * *';
const PATCH_CONCURRENCY = parseInt(process.env.PATCH_CONCURRENCY ?? '3', 10);

let isRunning = false;
let jobStatus: JobStatus = { state: 'idle', progress: null, lastRun: null };

export function getJobStatus(): JobStatus {
  return jobStatus;
}

export async function runPatchCycle(): Promise<boolean> {
  if (isRunning) return false;

  isRunning = true;
  const startedAt = new Date().toISOString();
  const summary = { patched: 0, unpatchable: 0, failed: 0, total: 0 };

  try {
    const manifest = await readManifest();
    const images = manifest.images.filter(
      (img) => img.status !== 'downloading' && img.status !== 'scanning' && img.status !== 'patching'
    );
    summary.total = images.length;

    let completed = 0;
    jobStatus = { state: 'running', progress: `0/${summary.total}`, lastRun: null };

    const limit = pLimit(PATCH_CONCURRENCY);

    await Promise.all(
      images.map((image) =>
        limit(async () => {
          try {
            const result = await patchImage(image);
            if (result.status === 'ready') summary.patched++;
            else if (result.status === 'ready-unpatched') summary.unpatchable++;
          } catch {
            summary.failed++;
          } finally {
            completed++;
            jobStatus = { ...jobStatus, progress: `${completed}/${summary.total}` };
          }
        })
      )
    );
  } finally {
    isRunning = false;
    const lastRun: LastRunSummary = {
      startedAt,
      completedAt: new Date().toISOString(),
      total: summary.total,
      patched: summary.patched,
      unpatchable: summary.unpatchable,
      failed: summary.failed,
    };
    jobStatus = { state: 'idle', progress: null, lastRun };
  }

  return true;
}

export function startScheduler(): void {
  if (!cron.validate(PATCH_SCHEDULE)) {
    console.warn(`Invalid PATCH_SCHEDULE "${PATCH_SCHEDULE}", defaulting to "0 2 * * *"`);
  }

  const schedule = cron.validate(PATCH_SCHEDULE) ? PATCH_SCHEDULE : '0 2 * * *';
  cron.schedule(schedule, () => {
    runPatchCycle().catch((err) => console.error('Patch cycle error:', err));
  });

  console.log(`Patch scheduler started with schedule: ${schedule}`);
}
