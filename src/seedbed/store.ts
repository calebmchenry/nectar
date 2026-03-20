import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { SeedMeta, SeedPriority, SeedStatus, isValidStatus } from './types.js';
import { WorkspacePaths, allocateDirectory, slugify } from './paths.js';
import { renderSeedMarkdown } from './markdown.js';

export interface CreateSeedOptions {
  title?: string;
  body: string;
  priority?: SeedPriority;
  tags?: string[];
}

export class SeedStore {
  constructor(readonly ws: WorkspacePaths) {}

  async create(opts: CreateSeedOptions): Promise<SeedMeta> {
    const title = opts.title || deriveTitle(opts.body);
    if (!title) {
      throw new Error('Cannot create a seed without a title. Provide --title or non-empty text.');
    }

    const slug = slugify(title);
    const { id, dirPath } = await allocateDirectory(this.ws, slug);

    await mkdir(path.join(dirPath, 'attachments'), { recursive: true });
    await mkdir(path.join(dirPath, 'analysis'), { recursive: true });

    const now = new Date().toISOString();
    const meta: SeedMeta = {
      id,
      slug,
      title,
      status: 'seedling',
      priority: opts.priority ?? 'normal',
      tags: opts.tags ?? [],
      created_at: now,
      updated_at: now,
      linked_gardens: [],
      linked_runs: [],
      analysis_status: {
        claude: 'pending',
        codex: 'pending',
        gemini: 'pending',
      },
    };

    const markdown = renderSeedMarkdown(title, opts.body);
    await writeFile(path.join(dirPath, 'seed.md'), markdown, 'utf8');
    await atomicWriteYaml(path.join(dirPath, 'meta.yaml'), meta);

    return meta;
  }

  async get(id: number): Promise<{ meta: SeedMeta; seedMd: string; dirPath: string } | null> {
    const entry = await this.findEntry(id);
    if (!entry) {
      return null;
    }

    const metaPath = path.join(entry.dirPath, 'meta.yaml');
    const mdPath = path.join(entry.dirPath, 'seed.md');

    let metaRaw: string;
    try {
      metaRaw = await readFile(metaPath, 'utf8');
    } catch {
      return null;
    }

    const meta = yamlParse(metaRaw) as SeedMeta;
    let seedMd: string;
    try {
      seedMd = await readFile(mdPath, 'utf8');
    } catch {
      seedMd = '';
    }

    return { meta, seedMd, dirPath: entry.dirPath };
  }

  async list(): Promise<{ meta: SeedMeta; dirPath: string; location: 'seedbed' | 'honey' }[]> {
    const results: { meta: SeedMeta; dirPath: string; location: 'seedbed' | 'honey' }[] = [];

    for (const [dir, location] of [[this.ws.seedbed, 'seedbed'], [this.ws.honey, 'honey']] as const) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const metaPath = path.join(dir, entry, 'meta.yaml');
        try {
          const raw = await readFile(metaPath, 'utf8');
          const meta = yamlParse(raw) as SeedMeta;
          results.push({ meta, dirPath: path.join(dir, entry), location });
        } catch {
          // Skip entries without valid meta.yaml
        }
      }
    }

    results.sort((a, b) => a.meta.id - b.meta.id);
    return results;
  }

  async updateMeta(id: number, updates: Partial<Pick<SeedMeta, 'status' | 'priority' | 'tags'>>): Promise<SeedMeta> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Seed ${id} not found.`);
    }

    const meta: SeedMeta = {
      ...existing.meta,
      ...updates,
      updated_at: new Date().toISOString(),
    };

    await atomicWriteYaml(path.join(existing.dirPath, 'meta.yaml'), meta);

    // Handle archive boundary moves
    const oldStatus = existing.meta.status;
    const newStatus = meta.status;
    if (oldStatus !== newStatus) {
      const isNowHoney = newStatus === 'honey';
      const wasHoney = oldStatus === 'honey';

      if (isNowHoney && !existing.dirPath.startsWith(this.ws.honey)) {
        // Move to honey/
        const dirName = path.basename(existing.dirPath);
        const dest = path.join(this.ws.honey, dirName);
        await mkdir(this.ws.honey, { recursive: true });
        await rename(existing.dirPath, dest);
      } else if (wasHoney && !isNowHoney && existing.dirPath.startsWith(this.ws.honey)) {
        // Move back to seedbed/
        const dirName = path.basename(existing.dirPath);
        const dest = path.join(this.ws.seedbed, dirName);
        await mkdir(this.ws.seedbed, { recursive: true });
        await rename(existing.dirPath, dest);
      }
    }

    return meta;
  }

  private async findEntry(id: number): Promise<{ dirPath: string } | null> {
    const prefix = String(id).padStart(3, '0') + '-';

    for (const dir of [this.ws.seedbed, this.ws.honey]) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.startsWith(prefix)) {
          return { dirPath: path.join(dir, entry) };
        }
      }
    }

    // Also try without padding for IDs > 999
    const altPrefix = String(id) + '-';
    if (altPrefix !== prefix) {
      for (const dir of [this.ws.seedbed, this.ws.honey]) {
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (entry.startsWith(altPrefix)) {
            return { dirPath: path.join(dir, entry) };
          }
        }
      }
    }

    return null;
  }
}

function deriveTitle(body: string): string {
  const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0);
  return firstLine?.trim().slice(0, 120) ?? '';
}

async function atomicWriteYaml(filePath: string, data: SeedMeta): Promise<void> {
  const tmpPath = filePath + '.tmp';
  const content = yamlStringify(data);
  await writeFile(tmpPath, content, 'utf8');
  await rename(tmpPath, filePath);
}

export function isSeedStatusValid(value: string): value is SeedStatus {
  return isValidStatus(value);
}
