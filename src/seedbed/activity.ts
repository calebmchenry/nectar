import { appendFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkspacePaths } from './paths.js';
import type { SeedActivityEvent } from './types.js';

export interface SeedActivityListOptions {
  limit?: number;
  before?: string;
}

type SeedActivityEventType = SeedActivityEvent['type'];

// Preserve discriminated payload fields per activity type while allowing optional custom timestamp.
export type SeedActivityEventInput = {
  [Type in SeedActivityEventType]: Omit<Extract<SeedActivityEvent, { type: Type }>, 'seed_id' | 'timestamp'> & {
    timestamp?: string;
  };
}[SeedActivityEventType];

interface ParsedActivityLine {
  event: SeedActivityEvent;
  index: number;
}

export class SeedActivityStore {
  constructor(private readonly ws: WorkspacePaths) {}

  async append(seedId: number, event: SeedActivityEventInput): Promise<SeedActivityEvent | null> {
    const seedDir = await this.findSeedDirectory(seedId);
    if (!seedDir) {
      throw new Error(`Seed ${seedId} not found.`);
    }

    const activityPath = path.join(seedDir, 'activity.jsonl');
    const timestamp = event.timestamp ?? new Date().toISOString();
    const enriched = {
      ...event,
      seed_id: seedId,
      timestamp,
    } as SeedActivityEvent;

    if (enriched.idempotency_key) {
      const existing = await this.list(seedId, { limit: 5_000 });
      if (existing.some((entry) => entry.idempotency_key === enriched.idempotency_key)) {
        return null;
      }
    }

    await appendFile(activityPath, `${JSON.stringify(enriched)}\n`, 'utf8');
    return enriched;
  }

  async list(seedId: number, options: SeedActivityListOptions = {}): Promise<SeedActivityEvent[]> {
    const seedDir = await this.findSeedDirectory(seedId);
    if (!seedDir) {
      return [];
    }

    const activityPath = path.join(seedDir, 'activity.jsonl');
    const parsed = await readActivityLines(activityPath);
    return applyListWindow(parsed, options);
  }

  async listWorkspace(options: SeedActivityListOptions = {}): Promise<SeedActivityEvent[]> {
    const allEvents: ParsedActivityLine[] = [];
    let lineIndex = 0;

    for (const baseDir of [this.ws.seedbed, this.ws.honey]) {
      let entries: string[];
      try {
        entries = await readdir(baseDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const seedId = parseSeedIdFromDirectory(entry);
        if (!seedId) {
          continue;
        }

        const activityPath = path.join(baseDir, entry, 'activity.jsonl');
        const parsed = await readActivityLines(activityPath);
        for (const line of parsed) {
          allEvents.push({
            event: line.event,
            index: lineIndex++,
          });
        }
      }
    }

    return applyListWindow(allEvents, options);
  }

  private async findSeedDirectory(seedId: number): Promise<string | null> {
    const prefixes = [`${String(seedId).padStart(3, '0')}-`, `${seedId}-`];

    for (const baseDir of [this.ws.seedbed, this.ws.honey]) {
      let entries: string[];
      try {
        entries = await readdir(baseDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (prefixes.some((prefix) => entry.startsWith(prefix))) {
          return path.join(baseDir, entry);
        }
      }
    }

    return null;
  }
}

async function readActivityLines(filePath: string): Promise<ParsedActivityLine[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const lines = raw.split(/\r?\n/);
  const parsed: ParsedActivityLine[] = [];

  for (const [index, line] of lines.entries()) {
    if (!line || line.trim().length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(line) as SeedActivityEvent;
      if (
        typeof event !== 'object' ||
        event === null ||
        typeof event.type !== 'string' ||
        typeof event.timestamp !== 'string' ||
        !Number.isInteger(event.seed_id)
      ) {
        continue;
      }
      parsed.push({ event, index });
    } catch {
      // Malformed lines are skipped so one corrupted append does not brick the seed.
    }
  }

  return parsed;
}

function applyListWindow(lines: ParsedActivityLine[], options: SeedActivityListOptions): SeedActivityEvent[] {
  const before = options.before;
  const limit = Math.max(1, options.limit ?? 100);

  const filtered = before
    ? lines.filter((line) => line.event.timestamp < before)
    : lines.slice();

  filtered.sort((a, b) => {
    if (a.event.timestamp === b.event.timestamp) {
      return b.index - a.index;
    }
    return b.event.timestamp.localeCompare(a.event.timestamp);
  });

  return filtered.slice(0, limit).map((line) => line.event);
}

function parseSeedIdFromDirectory(value: string): number | null {
  const match = value.match(/^(\d+)-/);
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
