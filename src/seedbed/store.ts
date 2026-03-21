import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { parseSeedMarkdown, renderSeedMarkdown } from './markdown.js';
import { AnalysisStatus, MAX_LINKED_RUNS, SeedMeta, SeedPriority, SeedStatus, isValidStatus } from './types.js';
import { WorkspacePaths, allocateDirectory, slugify } from './paths.js';

export interface CreateSeedOptions {
  title?: string;
  body: string;
  priority?: SeedPriority;
  tags?: string[];
}

export interface SeedPatchOptions {
  title?: string;
  body?: string;
  status?: SeedStatus;
  priority?: SeedPriority;
  tags?: string[];
  analysis_status?: Record<string, AnalysisStatus>;
  linked_gardens_add?: string[];
  linked_gardens_remove?: string[];
  linked_runs_add?: string[];
}

export class SeedStore {
  private readonly patchChains = new Map<number, Promise<unknown>>();

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
    await writeFile(path.join(dirPath, 'activity.jsonl'), '', 'utf8');

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
    return this.patch(id, updates);
  }

  async patch(id: number, updates: SeedPatchOptions): Promise<SeedMeta> {
    return this.queuePatch(id, async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`Seed ${id} not found.`);
      }

      const nextMeta: SeedMeta = {
        ...existing.meta,
        updated_at: new Date().toISOString(),
        linked_gardens: [...(existing.meta.linked_gardens ?? [])],
        linked_runs: normalizeLinkedRuns(existing.meta.linked_runs ?? []),
      };

      if (updates.status !== undefined) {
        nextMeta.status = updates.status;
      }
      if (updates.priority !== undefined) {
        nextMeta.priority = updates.priority;
      }
      if (updates.tags !== undefined) {
        nextMeta.tags = normalizeTags(updates.tags);
      }
      if (updates.analysis_status !== undefined) {
        nextMeta.analysis_status = {
          ...existing.meta.analysis_status,
          ...updates.analysis_status,
        };
      }
      if (updates.linked_gardens_add !== undefined || updates.linked_gardens_remove !== undefined) {
        const linkedGardens = [...nextMeta.linked_gardens];
        if (updates.linked_gardens_add) {
          for (const rawPath of updates.linked_gardens_add) {
            const normalizedPath = normalizeGardenLink(rawPath, this.ws.root);
            if (!linkedGardens.includes(normalizedPath)) {
              linkedGardens.push(normalizedPath);
            }
          }
        }
        if (updates.linked_gardens_remove) {
          const removals = new Set(
            updates.linked_gardens_remove.map((rawPath) => normalizeGardenLink(rawPath, this.ws.root))
          );
          nextMeta.linked_gardens = linkedGardens.filter((linked) => !removals.has(linked));
        } else {
          nextMeta.linked_gardens = linkedGardens;
        }
      }
      if (updates.linked_runs_add) {
        for (const rawRunId of updates.linked_runs_add) {
          const runId = rawRunId.trim();
          if (!runId) {
            continue;
          }
          nextMeta.linked_runs = [runId, ...nextMeta.linked_runs.filter((existingRunId) => existingRunId !== runId)];
        }
        nextMeta.linked_runs = nextMeta.linked_runs.slice(0, MAX_LINKED_RUNS);
      }

      let nextSeedMd = existing.seedMd;
      if (updates.title !== undefined || updates.body !== undefined) {
        const parsed = parseSeedMarkdown(existing.seedMd);
        const title =
          updates.title !== undefined
            ? normalizeTitle(updates.title)
            : parsed.title || existing.meta.title;
        const body = updates.body !== undefined ? updates.body.trim() : parsed.body;
        nextMeta.title = title;
        nextSeedMd = renderSeedMarkdown(title, body, parsed.attachments_section);
      }

      const metaPath = path.join(existing.dirPath, 'meta.yaml');
      const seedPath = path.join(existing.dirPath, 'seed.md');

      if (nextSeedMd !== existing.seedMd) {
        await atomicWriteText(seedPath, nextSeedMd);
      }
      await atomicWriteYaml(metaPath, nextMeta);

      await this.reconcileArchiveBoundary(existing.dirPath, existing.meta.status, nextMeta.status);
      return nextMeta;
    });
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

  private async reconcileArchiveBoundary(
    dirPath: string,
    previousStatus: SeedStatus,
    nextStatus: SeedStatus
  ): Promise<void> {
    if (previousStatus === nextStatus) {
      return;
    }

    const isNowHoney = nextStatus === 'honey';
    const wasHoney = previousStatus === 'honey';

    if (isNowHoney && !dirPath.startsWith(this.ws.honey)) {
      const dirName = path.basename(dirPath);
      const destination = path.join(this.ws.honey, dirName);
      await mkdir(this.ws.honey, { recursive: true });
      await rename(dirPath, destination);
      return;
    }

    if (wasHoney && !isNowHoney && dirPath.startsWith(this.ws.honey)) {
      const dirName = path.basename(dirPath);
      const destination = path.join(this.ws.seedbed, dirName);
      await mkdir(this.ws.seedbed, { recursive: true });
      await rename(dirPath, destination);
    }
  }

  private queuePatch<T>(id: number, task: () => Promise<T>): Promise<T> {
    const previous = this.patchChains.get(id) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(task);

    this.patchChains.set(id, current);
    return current.finally(() => {
      if (this.patchChains.get(id) === current) {
        this.patchChains.delete(id);
      }
    });
  }
}

function deriveTitle(body: string): string {
  const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0);
  return firstLine?.trim().slice(0, 120) ?? '';
}

async function atomicWriteYaml(filePath: string, data: SeedMeta): Promise<void> {
  await atomicWriteText(filePath, yamlStringify(data));
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, content, 'utf8');
  await rename(tmpPath, filePath);
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized) {
    throw new Error('Seed title cannot be empty.');
  }
  return normalized;
}

function normalizeTags(tags: string[]): string[] {
  return tags
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function normalizeLinkedRuns(runIds: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const rawRunId of runIds) {
    const runId = rawRunId.trim();
    if (!runId || seen.has(runId)) {
      continue;
    }
    seen.add(runId);
    deduped.push(runId);
    if (deduped.length >= MAX_LINKED_RUNS) {
      break;
    }
  }

  return deduped;
}

function normalizeGardenLink(rawPath: string, workspaceRoot: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error('Garden link path must not be empty.');
  }

  const absolute = path.resolve(workspaceRoot, trimmed);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Garden link path '${rawPath}' resolves outside workspace root.`);
  }

  const normalized = relative.split(path.sep).join('/');
  if (!normalized.startsWith('gardens/')) {
    throw new Error(`Garden link path '${rawPath}' must be inside gardens/.`);
  }
  if (!normalized.endsWith('.dot')) {
    throw new Error(`Garden link path '${rawPath}' must end with .dot.`);
  }
  return normalized;
}

export function isSeedStatusValid(value: string): value is SeedStatus {
  return isValidStatus(value);
}
