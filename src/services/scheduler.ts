import cron from 'node-cron';
import pLimit from 'p-limit';
import { getAllImages } from './database.js';
import { patchImage } from './patcher.js';
import { JobStatus, LastRunSummary } from '../types/index.js';
import { createLogger } from '../logger.js';

const logger = createLogger('scheduler');

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
    const allImages = await getAllImages();
    const images = allImages.filter(
      (img) => img.status !== 'downloading' && img.status !== 'scanning' && img.status !== 'patching'
    );
    summary.total = images.length;
    logger.info('Patch cycle started', { total: summary.total });

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
    logger.info('Patch cycle finished', { ...lastRun });
  }

  return true;
}

export function startScheduler(): void {
  if (!cron.validate(PATCH_SCHEDULE)) {
    logger.warn(`Invalid PATCH_SCHEDULE "${PATCH_SCHEDULE}", defaulting to "0 2 * * *"`);
  }

  const schedule = cron.validate(PATCH_SCHEDULE) ? PATCH_SCHEDULE : '0 2 * * *';
  cron.schedule(schedule, () => {
    runPatchCycle().catch((err) => logger.error('Patch cycle error', { err: String(err) }));
  });

  logger.info('Patch scheduler started', { schedule });
}
