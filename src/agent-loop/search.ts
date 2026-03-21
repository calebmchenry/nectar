import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';

interface SearchEnvironment {
  workspaceRoot: string;
  resolvePath(filePath: string): Promise<string>;
  statFile?: (relativePath: string) => Promise<number>;
}

export interface GrepSearchOptions {
  path?: string;
  include?: string;
  caseInsensitive?: boolean;
  maxResults?: number;
}

export interface GlobSearchOptions {
  path?: string;
  maxResults?: number;
}

export interface GrepMatch {
  relative_path: string;
  line: number;
  content: string;
}

export async function runGlobSearch(
  env: SearchEnvironment,
  pattern: string,
  optionsOrMaxResults: number | GlobSearchOptions = 200,
): Promise<string[]> {
  const options = typeof optionsOrMaxResults === 'number'
    ? { maxResults: optionsOrMaxResults }
    : optionsOrMaxResults;
  const limit = Math.max(0, options.maxResults ?? 200);
  const rootDir = env.workspaceRoot;
  const startDir = options.path
    ? await env.resolvePath(options.path)
    : rootDir;
  const ig = await loadGitignore(rootDir);
  const results: string[] = [];

  for await (const relativePath of walkRelativeFiles(startDir, rootDir, ig)) {
    if (matchesGlobPath(relativePath, pattern)) {
      results.push(relativePath);
    }
  }

  const statResults = await Promise.allSettled(
    results.map(async (relativePath) => {
      const mtimeMs = await resolveMtimeMs(env, rootDir, relativePath);
      return { relativePath, mtimeMs };
    }),
  );

  const mtimeByPath = new Map<string, number | null>();
  for (const result of statResults) {
    if (result.status === 'fulfilled') {
      mtimeByPath.set(result.value.relativePath, result.value.mtimeMs);
    }
  }
  for (const relativePath of results) {
    if (!mtimeByPath.has(relativePath)) {
      mtimeByPath.set(relativePath, null);
    }
  }

  results.sort((a, b) => {
    const aMtime = mtimeByPath.get(a);
    const bMtime = mtimeByPath.get(b);
    const aMissing = aMtime === null || aMtime === undefined;
    const bMissing = bMtime === null || bMtime === undefined;

    if (aMissing && bMissing) {
      return a.localeCompare(b);
    }
    if (aMissing) {
      return 1;
    }
    if (bMissing) {
      return -1;
    }
    if (aMtime !== bMtime) {
      return bMtime - aMtime;
    }
    return a.localeCompare(b);
  });

  return results.slice(0, limit);
}

export async function runGrepSearch(
  env: SearchEnvironment,
  pattern: string,
  options?: GrepSearchOptions,
): Promise<GrepMatch[]> {
  const rootDir = env.workspaceRoot;
  const limit = Math.max(0, options?.maxResults ?? 200);
  const flags = options?.caseInsensitive ? 'i' : undefined;
  const regex = new RegExp(pattern, flags);
  const startDir = options?.path
    ? await env.resolvePath(options.path)
    : rootDir;

  const ig = await loadGitignore(rootDir);
  const matches: GrepMatch[] = [];

  for await (const filePath of walkAbsoluteFiles(startDir, rootDir, ig, options?.include)) {
    if (matches.length >= limit) {
      break;
    }

    try {
      const bytes = await readFile(filePath);
      if (isBinaryBuffer(bytes)) {
        continue;
      }

      const content = bytes.toString('utf8');
      const lines = content.split('\n');
      const relativePath = path.relative(rootDir, filePath);
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= limit) {
          break;
        }
        if (regex.test(lines[i]!)) {
          matches.push({
            relative_path: relativePath,
            line: i + 1,
            content: lines[i]!,
          });
        }
      }
    } catch {
      // Ignore unreadable files.
    }
  }

  return matches;
}

async function loadGitignore(rootDir: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();
  ig.add(['.git', 'node_modules']);
  try {
    const content = await readFile(path.join(rootDir, '.gitignore'), 'utf8');
    ig.add(content);
  } catch {
    // Missing .gitignore is acceptable.
  }
  return ig;
}

function matchesGlobPath(relativePath: string, pattern: string): boolean {
  if (pattern === '**/*' || pattern === '*') {
    return true;
  }

  if (pattern.startsWith('**/*.')) {
    const ext = pattern.slice(4);
    return relativePath.endsWith(ext);
  }

  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1);
    return relativePath.endsWith(ext);
  }

  const doubleStarIdx = pattern.indexOf('/**/');
  if (doubleStarIdx !== -1) {
    const prefix = pattern.slice(0, doubleStarIdx);
    const suffix = pattern.slice(doubleStarIdx + 4);
    if (!relativePath.startsWith(`${prefix}/`) && relativePath !== prefix) {
      return false;
    }
    const rest = relativePath.slice(prefix.length + 1);
    return matchesGlobPath(rest, `**/${suffix}`) || matchesGlobPath(rest, suffix);
  }

  if (pattern.includes('/') && pattern.includes('*.')) {
    const lastSlash = pattern.lastIndexOf('/');
    const dir = pattern.slice(0, lastSlash);
    const filePattern = pattern.slice(lastSlash + 1);
    const relDir = path.dirname(relativePath);
    const fileName = path.basename(relativePath);
    if (relDir !== dir) {
      return false;
    }
    if (filePattern.startsWith('*.')) {
      return fileName.endsWith(filePattern.slice(1));
    }
    return fileName === filePattern;
  }

  return relativePath === pattern;
}

function matchesIncludePattern(fileName: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    return fileName.endsWith(pattern.slice(1));
  }
  if (pattern.startsWith('**/*.')) {
    return fileName.endsWith(pattern.slice(4));
  }
  return fileName === pattern;
}

async function *walkRelativeFiles(
  dir: string,
  rootDir: string,
  ig: ReturnType<typeof ignore>,
): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(rootDir, fullPath);

    if (ig.ignores(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      if (ig.ignores(`${relativePath}/`)) {
        continue;
      }
      yield *walkRelativeFiles(fullPath, rootDir, ig);
    } else if (entry.isFile()) {
      yield relativePath;
    }
  }
}

async function *walkAbsoluteFiles(
  dir: string,
  rootDir: string,
  ig: ReturnType<typeof ignore>,
  includePattern?: string,
): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(rootDir, fullPath);

    if (ig.ignores(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      if (ig.ignores(`${relativePath}/`)) {
        continue;
      }
      yield *walkAbsoluteFiles(fullPath, rootDir, ig, includePattern);
    } else if (entry.isFile()) {
      if (includePattern && !matchesIncludePattern(entry.name, includePattern)) {
        continue;
      }
      yield fullPath;
    }
  }
}

async function resolveMtimeMs(
  env: SearchEnvironment,
  rootDir: string,
  relativePath: string,
): Promise<number> {
  if (typeof env.statFile === 'function') {
    return env.statFile(relativePath);
  }
  const info = await stat(path.join(rootDir, relativePath));
  return info.mtimeMs;
}

function isBinaryBuffer(bytes: Buffer): boolean {
  const max = Math.min(bytes.length, 512);
  for (let i = 0; i < max; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}
