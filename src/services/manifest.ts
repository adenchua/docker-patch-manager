import fs from 'fs/promises';
import path from 'path';
import { ManifestFile, ManifestImage } from '../types/index.js';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');

async function ensureManifestExists(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(MANIFEST_PATH);
  } catch {
    await fs.writeFile(MANIFEST_PATH, JSON.stringify({ images: [] }, null, 2));
  }
}

export async function readManifest(): Promise<ManifestFile> {
  await ensureManifestExists();
  const raw = await fs.readFile(MANIFEST_PATH, 'utf-8');
  return JSON.parse(raw) as ManifestFile;
}

export async function writeManifest(manifest: ManifestFile): Promise<void> {
  await ensureManifestExists();
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

export async function updateImage(updated: ManifestImage): Promise<void> {
  const manifest = await readManifest();
  const idx = manifest.images.findIndex((img) => img.name === updated.name && img.registry === updated.registry);
  if (idx === -1) {
    manifest.images.push(updated);
  } else {
    manifest.images[idx] = updated;
  }
  await writeManifest(manifest);
}

export async function removeImage(name: string): Promise<ManifestImage | null> {
  const manifest = await readManifest();
  const idx = manifest.images.findIndex((img) => img.name === name);
  if (idx === -1) return null;
  const [removed] = manifest.images.splice(idx, 1);
  await writeManifest(manifest);
  return removed;
}

export function tarFilename(image: ManifestImage): string {
  const safeName = image.name.replace(/\//g, '_');
  return path.join(DATA_DIR, 'images', `${safeName}_${image.tag}.tgz`);
}

export async function ensureImagesDir(): Promise<void> {
  await fs.mkdir(path.join(DATA_DIR, 'images'), { recursive: true });
}
