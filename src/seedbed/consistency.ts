import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as yamlParse } from 'yaml';
import { ConsistencyIssue, SeedMeta, SEED_STATUSES, SEED_PRIORITIES } from './types.js';
import { WorkspacePaths } from './paths.js';

const REQUIRED_META_KEYS = ['id', 'slug', 'title', 'status', 'priority', 'tags', 'created_at', 'updated_at'];

export async function checkConsistency(ws: WorkspacePaths): Promise<ConsistencyIssue[]> {
  const issues: ConsistencyIssue[] = [];

  for (const [dir, location] of [[ws.seedbed, 'seedbed'], [ws.honey, 'honey']] as const) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const dirPath = path.join(dir, entry);
      const metaPath = path.join(dirPath, 'meta.yaml');

      const idMatch = entry.match(/^(\d+)-/);
      const seedId = idMatch?.[1] ? Number.parseInt(idMatch[1], 10) : 0;

      let raw: string;
      try {
        raw = await readFile(metaPath, 'utf8');
      } catch {
        issues.push({
          seedId,
          directory: dirPath,
          code: 'MISSING_META',
          message: `Missing meta.yaml in ${entry}`,
        });
        continue;
      }

      let meta: Record<string, unknown>;
      try {
        meta = yamlParse(raw) as Record<string, unknown>;
      } catch {
        issues.push({
          seedId,
          directory: dirPath,
          code: 'MALFORMED_META',
          message: `Malformed meta.yaml in ${entry}`,
        });
        continue;
      }

      // Check required keys
      for (const key of REQUIRED_META_KEYS) {
        if (meta[key] === undefined || meta[key] === null) {
          issues.push({
            seedId,
            directory: dirPath,
            code: 'MISSING_KEY',
            message: `Missing required key "${key}" in ${entry}/meta.yaml`,
          });
        }
      }

      const status = meta.status as string | undefined;
      const priority = meta.priority as string | undefined;

      // Check status validity
      if (status && !(SEED_STATUSES as readonly string[]).includes(status)) {
        issues.push({
          seedId,
          directory: dirPath,
          code: 'UNKNOWN_STATUS',
          message: `Unknown status "${status}" in ${entry}/meta.yaml`,
        });
      }

      // Check priority validity
      if (priority && !(SEED_PRIORITIES as readonly string[]).includes(priority)) {
        issues.push({
          seedId,
          directory: dirPath,
          code: 'UNKNOWN_PRIORITY',
          message: `Unknown priority "${priority}" in ${entry}/meta.yaml`,
        });
      }

      // Check placement consistency
      if (location === 'honey' && status && status !== 'honey') {
        issues.push({
          seedId,
          directory: dirPath,
          code: 'PLACEMENT_MISMATCH',
          message: `Seed in honey/ but status is "${status}" (expected "honey")`,
        });
      }

      if (location === 'seedbed' && status === 'honey') {
        issues.push({
          seedId,
          directory: dirPath,
          code: 'PLACEMENT_MISMATCH',
          message: `Seed in seedbed/ but status is "honey" (should be in honey/)`,
        });
      }
    }
  }

  issues.sort((a, b) => a.seedId - b.seedId);
  return issues;
}
