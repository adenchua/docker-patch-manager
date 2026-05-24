import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import { readManifest, writeManifest, removeImage, tarFilename } from '../services/manifest.js';
import { ManifestImage } from '../types/index.js';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const manifest = await readManifest();
  res.json(manifest.images);
});

router.post('/', async (req: Request, res: Response) => {
  const { name, tag, registry, architecture } = req.body as Partial<ManifestImage>;

  if (!name || !tag || !registry || !architecture) {
    res.status(400).json({ error: 'name, tag, registry, and architecture are required' });
    return;
  }

  const manifest = await readManifest();
  const existing = manifest.images.find((img) => img.name === name && img.registry === registry);
  if (existing) {
    res.status(409).json({ error: 'Image already exists in manifest' });
    return;
  }

  const newImage: ManifestImage = {
    name,
    tag,
    registry,
    architecture,
    status: 'pending',
    tarPath: null,
    lastScanned: null,
    lastPatched: null,
    vulnerabilities: null,
  };

  manifest.images.push(newImage);
  await writeManifest(manifest);
  res.status(201).json(newImage);
});

router.delete('/:name', async (req: Request, res: Response) => {
  const name = req.params['name'] as string;
  const removed = await removeImage(name);

  if (!removed) {
    res.status(404).json({ error: 'Image not found' });
    return;
  }

  if (removed.tarPath) {
    const fullTarPath = tarFilename(removed);
    await fs.unlink(fullTarPath).catch(() => {});
  }

  res.status(204).send();
});

export default router;
