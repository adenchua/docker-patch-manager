import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import { getAllImages, getImage, upsertImage, removeImageById, getImageById, outputPath } from '../services/database.js';
import { patchImage } from '../services/patcher.js';
import { Image, ImageStatus } from '../types/index.js';
import { createLogger } from '../logger.js';

const logger = createLogger('images');

const NAME_RE = /^[a-zA-Z0-9._\-\/]{1,128}$/;
const TAG_RE = /^[a-zA-Z0-9._\-]{1,128}$/;
const REGISTRY_RE = /^[a-zA-Z0-9.\-]+(:\d{1,5})?$/;
const ARCH_ALLOWLIST = new Set([
  'linux/amd64', 'linux/arm64', 'linux/arm/v7',
  'linux/arm/v6', 'linux/386', 'linux/ppc64le', 'linux/s390x',
]);

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const images = await getAllImages();
  res.json(images);
});

router.post('/', async (req: Request, res: Response) => {
  const { name, tag, registry, architecture } = req.body as Partial<Image>;

  if (!name || !tag || !registry || !architecture) {
    res.status(400).json({ error: 'name, tag, registry, and architecture are required' });
    return;
  }

  if (!NAME_RE.test(name)) {
    res.status(400).json({ error: 'name contains invalid characters' });
    return;
  }
  if (!TAG_RE.test(tag)) {
    res.status(400).json({ error: 'tag contains invalid characters' });
    return;
  }
  if (!REGISTRY_RE.test(registry)) {
    res.status(400).json({ error: 'registry format is invalid' });
    return;
  }
  if (!ARCH_ALLOWLIST.has(architecture)) {
    res.status(400).json({ error: `architecture must be one of: ${[...ARCH_ALLOWLIST].join(', ')}` });
    return;
  }

  const existing = await getImage(name, tag, registry, architecture);
  if (existing) {
    res.status(409).json({ error: 'Image already exists' });
    return;
  }

  const newImage: Image = {
    name,
    tag,
    registry,
    architecture,
    status: 'pending',
    lastScanned: null,
    lastPatched: null,
    vulnerabilities: null,
  };

  await upsertImage(newImage);
  const savedImage = (await getImage(name, tag, registry, architecture))!;
  res.status(201).json(savedImage);
  patchImage(savedImage).catch((err) =>
    logger.warn('Background patch failed', { image: `${savedImage.registry}/${savedImage.name}:${savedImage.tag}`, err: String(err) })
  );
});

router.delete('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params['id'] as string, 10);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: 'id must be a positive integer' });
    return;
  }

  const removed = await removeImageById(id);
  if (!removed) {
    res.status(404).json({ error: 'Image not found' });
    return;
  }

  await fs.unlink(outputPath(removed)).catch(() => {});
  res.status(204).send();
});

const BUSY_STATUSES = new Set<ImageStatus>(['downloading', 'scanning', 'patching']);

router.post('/:id/scan', async (req: Request, res: Response) => {
  const id = parseInt(req.params['id'] as string, 10);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: 'id must be a positive integer' });
    return;
  }

  const image = await getImageById(id);
  if (!image) {
    res.status(404).json({ error: 'Image not found' });
    return;
  }

  if (BUSY_STATUSES.has(image.status)) {
    res.status(409).json({ error: `Image is currently busy (status: ${image.status})` });
    return;
  }

  patchImage(image).catch((err) =>
    logger.warn('Ad-hoc patch failed', { image: `${image.registry}/${image.name}:${image.tag}`, err: String(err) })
  );
  res.status(202).json(image);
});

export default router;
