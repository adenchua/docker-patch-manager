import { Router, Request, Response } from 'express';
import { runPatchCycle, getJobStatus } from '../services/scheduler.js';
import { readManifest } from '../services/manifest.js';

const router = Router();

router.post('/', async (_req: Request, res: Response) => {
  if (getJobStatus().state === 'running') {
    res.status(409).json({ message: 'A patch cycle is already running' });
    return;
  }

  const manifest = await readManifest();
  const images = manifest.images.filter(
    (img) => img.status !== 'downloading' && img.status !== 'scanning' && img.status !== 'patching'
  );

  runPatchCycle().catch(() => {});
  res.status(202).json({ message: 'Patch cycle started', images });
});

router.get('/status', (_req: Request, res: Response) => {
  res.json(getJobStatus());
});

export default router;
