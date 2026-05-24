import { Router, Request, Response } from 'express';
import { runPatchCycle, getJobStatus } from '../services/scheduler.js';

const router = Router();

router.post('/', async (_req: Request, res: Response) => {
  const started = await runPatchCycle();
  if (!started) {
    res.status(409).json({ message: 'A patch cycle is already running' });
    return;
  }
  res.status(202).json({ message: 'Patch cycle started' });
});

router.get('/status', (_req: Request, res: Response) => {
  res.json(getJobStatus());
});

export default router;
