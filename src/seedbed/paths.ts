import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

export interface WorkspacePaths {
  root: string;
  seedbed: string;
  honey: string;
  nectar: string;
}

export function workspacePathsFromRoot(root: string): WorkspacePaths {
  return {
    root,
    seedbed: path.join(root, 'seedbed'),
    honey: path.join(root, 'honey'),
    nectar: path.join(root, '.nectar'),
  };
}

export function workspacePathsFromCwd(): WorkspacePaths {
  return workspacePathsFromRoot(process.cwd());
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

export async function scanHighestId(ws: WorkspacePaths): Promise<number> {
  let highest = 0;
  for (const dir of [ws.seedbed, ws.honey]) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = entry.match(/^(\d+)-/);
      if (match?.[1]) {
        const num = Number.parseInt(match[1], 10);
        if (num > highest) {
          highest = num;
        }
      }
    }
  }
  return highest;
}

export function formatId(id: number): string {
  return String(id).padStart(3, '0');
}

export function dirName(id: number, slug: string): string {
  return `${formatId(id)}-${slug}`;
}

export async function allocateDirectory(ws: WorkspacePaths, slug: string): Promise<{ id: number; dirPath: string }> {
  await mkdir(ws.seedbed, { recursive: true });
  await mkdir(ws.honey, { recursive: true });

  let nextId = (await scanHighestId(ws)) + 1;
  const maxAttempts = 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const name = dirName(nextId, slug);
    const dirPath = path.join(ws.seedbed, name);
    try {
      await mkdir(dirPath, { recursive: false });
      return { id: nextId, dirPath };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        nextId++;
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Failed to allocate seed directory after ${maxAttempts} attempts`);
}
