import sqlite3 from 'sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { Image, ImageStatus, VulnerabilityCounts } from '../types/index.js';

const DATABASE_DIR = path.resolve('database');
const DATABASE_PATH = path.join(DATABASE_DIR, 'patch-manager.db');
const OUTPUT_DIR = path.resolve('output');

let db: sqlite3.Database;

function run(sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row as T);
    });
  });
}

function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as T[]);
    });
  });
}

interface ImageRow {
  id: number;
  name: string;
  tag: string;
  registry: string;
  architecture: string;
  status: string;
  last_scanned: string | null;
  last_patched: string | null;
  vulnerabilities_critical: number | null;
  vulnerabilities_high: number | null;
  vulnerabilities_medium: number | null;
  vulnerabilities_low: number | null;
}

function rowToImage(row: ImageRow): Image {
  const hasVulns =
    row.vulnerabilities_critical !== null ||
    row.vulnerabilities_high !== null ||
    row.vulnerabilities_medium !== null ||
    row.vulnerabilities_low !== null;

  const vulnerabilities: VulnerabilityCounts | null = hasVulns
    ? {
        critical: row.vulnerabilities_critical ?? 0,
        high: row.vulnerabilities_high ?? 0,
        medium: row.vulnerabilities_medium ?? 0,
        low: row.vulnerabilities_low ?? 0,
      }
    : null;

  return {
    id: row.id,
    name: row.name,
    tag: row.tag,
    registry: row.registry,
    architecture: row.architecture,
    status: row.status as ImageStatus,
    lastScanned: row.last_scanned,
    lastPatched: row.last_patched,
    vulnerabilities,
  };
}

export async function initDatabase(): Promise<void> {
  await fs.mkdir(DATABASE_DIR, { recursive: true });
  db = new sqlite3.Database(DATABASE_PATH);

  await run(`
    CREATE TABLE IF NOT EXISTS images (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      name                     TEXT NOT NULL,
      tag                      TEXT NOT NULL,
      registry                 TEXT NOT NULL,
      architecture             TEXT NOT NULL,
      status                   TEXT NOT NULL,
      last_scanned             TEXT,
      last_patched             TEXT,
      vulnerabilities_critical INTEGER,
      vulnerabilities_high     INTEGER,
      vulnerabilities_medium   INTEGER,
      vulnerabilities_low      INTEGER,
      UNIQUE(name, tag, registry, architecture)
    )
  `);

  // Reset transient states left over from a previous crash or restart so the
  // scheduler can pick them up again.
  await run(
    `UPDATE images SET status = 'pending' WHERE status IN ('downloading', 'scanning', 'patching')`
  );
}

export async function getAllImages(): Promise<Image[]> {
  const rows = await all<ImageRow>('SELECT * FROM images ORDER BY id ASC');
  return rows.map(rowToImage);
}

export async function getImage(
  name: string,
  tag: string,
  registry: string,
  architecture: string
): Promise<Image | null> {
  const row = await get<ImageRow>(
    'SELECT * FROM images WHERE name = ? AND tag = ? AND registry = ? AND architecture = ?',
    [name, tag, registry, architecture]
  );
  return row ? rowToImage(row) : null;
}

export async function getImageById(id: number): Promise<Image | null> {
  const row = await get<ImageRow>('SELECT * FROM images WHERE id = ?', [id]);
  return row ? rowToImage(row) : null;
}

export async function removeImageById(id: number): Promise<Image | null> {
  const existing = await getImageById(id);
  if (!existing) return null;
  await run('DELETE FROM images WHERE id = ?', [id]);
  return existing;
}

export async function upsertImage(image: Image): Promise<void> {
  await run(
    `INSERT OR REPLACE INTO images
      (name, tag, registry, architecture, status, last_scanned, last_patched,
       vulnerabilities_critical, vulnerabilities_high, vulnerabilities_medium, vulnerabilities_low)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      image.name,
      image.tag,
      image.registry,
      image.architecture,
      image.status,
      image.lastScanned,
      image.lastPatched,
      image.vulnerabilities?.critical ?? null,
      image.vulnerabilities?.high ?? null,
      image.vulnerabilities?.medium ?? null,
      image.vulnerabilities?.low ?? null,
    ]
  );
}

export async function updateImage(image: Image): Promise<void> {
  await run(
    `UPDATE images SET
      status = ?,
      last_scanned = ?,
      last_patched = ?,
      vulnerabilities_critical = ?,
      vulnerabilities_high = ?,
      vulnerabilities_medium = ?,
      vulnerabilities_low = ?
     WHERE name = ? AND tag = ? AND registry = ? AND architecture = ?`,
    [
      image.status,
      image.lastScanned,
      image.lastPatched,
      image.vulnerabilities?.critical ?? null,
      image.vulnerabilities?.high ?? null,
      image.vulnerabilities?.medium ?? null,
      image.vulnerabilities?.low ?? null,
      image.name,
      image.tag,
      image.registry,
      image.architecture,
    ]
  );
}

export async function removeImage(
  name: string,
  tag: string,
  registry: string,
  architecture: string
): Promise<Image | null> {
  const existing = await getImage(name, tag, registry, architecture);
  if (!existing) return null;
  await run(
    'DELETE FROM images WHERE name = ? AND tag = ? AND registry = ? AND architecture = ?',
    [name, tag, registry, architecture]
  );
  return existing;
}

export async function clearOutputDir(): Promise<void> {
  const entries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((e) => e.name !== '.gitkeep')
      .map((e) => {
        const full = path.join(OUTPUT_DIR, e.name);
        return e.isDirectory() ? fs.rm(full, { recursive: true }) : fs.unlink(full);
      })
  );
}

export function outputPath(image: Image): string {
  const archFolder = image.architecture.replace(/\//g, '-');
  const safeName = image.name.replace(/\//g, '_');
  return path.join(OUTPUT_DIR, archFolder, `${safeName}_${image.tag}.tgz`);
}

export async function ensureOutputDir(image: Image): Promise<void> {
  const archFolder = image.architecture.replace(/\//g, '-');
  await fs.mkdir(path.join(OUTPUT_DIR, archFolder), { recursive: true });
}
