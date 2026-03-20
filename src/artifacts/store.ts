import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactEntry, ArtifactIndex, ArtifactInfo } from './types.js';

const INLINE_THRESHOLD = 100 * 1024; // 100KB

export class ArtifactStore {
  private readonly dir: string;
  private index: ArtifactIndex = { artifacts: {} };
  private loaded = false;

  constructor(artifactsDir: string) {
    this.dir = artifactsDir;
  }

  private indexPath(): string {
    return path.join(this.dir, 'index.json');
  }

  private async loadIndex(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.indexPath(), 'utf8');
      this.index = JSON.parse(raw) as ArtifactIndex;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw error;
      this.index = { artifacts: {} };
    }
    this.loaded = true;
  }

  private async saveIndex(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tempPath = path.join(this.dir, `index.json.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tempPath, JSON.stringify(this.index, null, 2), 'utf8');
    try {
      await rename(tempPath, this.indexPath());
    } catch (error) {
      try { await unlink(tempPath); } catch { /* ignore */ }
      throw error;
    }
  }

  async store(id: string, name: string, data: string): Promise<ArtifactInfo> {
    await this.loadIndex();
    const size = Buffer.byteLength(data, 'utf8');
    const now = new Date().toISOString();
    const inline = size <= INLINE_THRESHOLD;

    const entry: ArtifactEntry = {
      id,
      name,
      size,
      created_at: now,
      inline,
    };

    if (inline) {
      entry.data = data;
    } else {
      await mkdir(this.dir, { recursive: true });
      const filePath = path.join(this.dir, `${id}.json`);
      await writeFile(filePath, JSON.stringify({ id, name, data }, null, 2), 'utf8');
    }

    this.index.artifacts[id] = entry;
    await this.saveIndex();

    return { id, name, size, created_at: now, inline };
  }

  async retrieve(id: string): Promise<string | null> {
    await this.loadIndex();
    const entry = this.index.artifacts[id];
    if (!entry) return null;

    if (entry.inline && entry.data !== undefined) {
      return entry.data;
    }

    // File-backed
    try {
      const filePath = path.join(this.dir, `${id}.json`);
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as { data: string };
      return parsed.data;
    } catch {
      return null;
    }
  }

  async has(id: string): Promise<boolean> {
    await this.loadIndex();
    return id in this.index.artifacts;
  }

  async list(): Promise<ArtifactInfo[]> {
    await this.loadIndex();
    return Object.values(this.index.artifacts).map((entry) => ({
      id: entry.id,
      name: entry.name,
      size: entry.size,
      created_at: entry.created_at,
      inline: entry.inline,
    }));
  }

  async remove(id: string): Promise<boolean> {
    await this.loadIndex();
    const entry = this.index.artifacts[id];
    if (!entry) return false;

    if (!entry.inline) {
      try {
        await unlink(path.join(this.dir, `${id}.json`));
      } catch { /* ignore */ }
    }

    delete this.index.artifacts[id];
    await this.saveIndex();
    return true;
  }

  async clear(): Promise<void> {
    await this.loadIndex();
    // Remove file-backed artifacts
    for (const entry of Object.values(this.index.artifacts)) {
      if (!entry.inline) {
        try {
          await unlink(path.join(this.dir, `${entry.id}.json`));
        } catch { /* ignore */ }
      }
    }
    this.index = { artifacts: {} };
    await this.saveIndex();
  }
}
