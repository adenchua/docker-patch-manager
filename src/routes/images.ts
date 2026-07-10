import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import semver from 'semver';
import {
  getAllImages,
  getImage,
  upsertImage,
  removeImageById,
  getImageById,
  outputPath,
} from '../services/database.js';
import { patchImage } from '../services/patcher.js';
import { Image, ImageStatus } from '../types/index.js';
import { createLogger } from '../logger.js';

const logger = createLogger('images');

const NAME_RE = /^[a-zA-Z0-9._\-\/]{1,128}$/;
const TAG_RE = /^[a-zA-Z0-9._\-]{1,128}$/;
// First character must be alphanumeric so a composed image ref can never
// start with '-' and be misread as a CLI flag by docker/copa.
const REGISTRY_RE = /^[a-zA-Z0-9][a-zA-Z0-9.\-]*(?::(\d{1,5}))?$/;

const ALLOWED_REGISTRIES = new Set(
  (process.env['ALLOWED_REGISTRIES'] ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
);
if (ALLOWED_REGISTRIES.size === 0) {
  logger.warn(
    'ALLOWED_REGISTRIES is not set — POST /images will accept any registry hostname, letting callers point this server at arbitrary hosts'
  );
}

function isValidRegistry(registry: string): boolean {
  const m = REGISTRY_RE.exec(registry);
  if (!m) return false;
  if (m[1] !== undefined) {
    const port = Number(m[1]);
    if (port < 1 || port > 65535) return false;
  }
  return true;
}
const ARCH_ALLOWLIST = new Set([
  'linux/amd64',
  'linux/arm64',
  'linux/arm/v7',
  'linux/arm/v6',
  'linux/386',
  'linux/ppc64le',
  'linux/s390x',
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
  if (!isValidRegistry(registry)) {
    res.status(400).json({ error: 'registry format is invalid' });
    return;
  }
  if (ALLOWED_REGISTRIES.size > 0 && !ALLOWED_REGISTRIES.has(registry)) {
    res.status(400).json({ error: `registry must be one of: ${[...ALLOWED_REGISTRIES].join(', ')}` });
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
    patchReason: null,
  };

  await upsertImage(newImage);
  const savedImage = (await getImage(name, tag, registry, architecture))!;
  res.status(201).json(savedImage);
  patchImage(savedImage).catch((err) =>
    logger.warn('Background patch failed', {
      image: `${savedImage.registry}/${savedImage.name}:${savedImage.tag}`,
      err: String(err),
    })
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

function parseTag(tag: string): { version: semver.SemVer; suffix: string } | null {
  const match = tag.match(/^(\d[\d.]*)(-.+)?$/);
  if (!match) return null;
  const coerced = semver.coerce(match[1]);
  if (!coerced) return null;
  return { version: coerced, suffix: match[2] ?? '' };
}

router.post('/cleanup', async (req: Request, res: Response) => {
  const dryRun = req.query['dryRun'] === 'true';
  const allImages = await getAllImages();

  const groups = new Map<string, Array<{ image: Image; parsed: semver.SemVer }>>();
  for (const image of allImages) {
    const parsed = parseTag(image.tag);
    if (!parsed) continue;
    const key = `${image.name}|${image.registry}|${image.architecture}|${parsed.version.major}|${parsed.suffix}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ image, parsed: parsed.version });
  }

  const toDelete: Image[] = [];
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    entries.sort((a, b) => semver.rcompare(a.parsed, b.parsed));
    const [, ...candidates] = entries;
    for (const { image } of candidates) {
      if (!BUSY_STATUSES.has(image.status)) toDelete.push(image);
    }
  }

  if (dryRun) {
    res.status(200).json({ dryRun: true, count: toDelete.length, images: toDelete });
    return;
  }

  for (const image of toDelete) {
    await removeImageById(image.id!);
    await fs.unlink(outputPath(image)).catch(() => {});
  }

  res.status(200).json({ dryRun: false, count: toDelete.length, images: toDelete });
});

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
