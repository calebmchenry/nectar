import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import type { ToolHandler } from '../tool-registry.js';

export const globSchema = {
  properties: {
    pattern: { type: 'string', description: 'Glob pattern to match files (e.g. "**/*.ts", "src/*.js")' },
    max_results: { type: 'integer', default: 200, description: 'Maximum number of results' },
  },
  required: ['pattern'],
  additionalProperties: false,
};

async function loadGitignore(dir: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();
  ig.add(['.git', 'node_modules']);
  try {
    const content = await readFile(path.join(dir, '.gitignore'), 'utf8');
    ig.add(content);
  } catch {
    // No .gitignore
  }
  return ig;
}

function matchesPattern(relativePath: string, pattern: string): boolean {
  // Handle common glob patterns
  if (pattern === '**/*' || pattern === '*') {
    return true;
  }

  // **/*.ext — match any file with extension
  if (pattern.startsWith('**/*.')) {
    const ext = pattern.slice(4); // includes the dot, e.g. ".ts"
    return relativePath.endsWith(ext);
  }

  // *.ext — match files in any directory with extension
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1);
    return relativePath.endsWith(ext);
  }

  // dir/**/*.ext
  const doubleStarIdx = pattern.indexOf('/**/');
  if (doubleStarIdx !== -1) {
    const prefix = pattern.slice(0, doubleStarIdx);
    const suffix = pattern.slice(doubleStarIdx + 4);
    if (!relativePath.startsWith(prefix + '/') && relativePath !== prefix) return false;
    const rest = relativePath.slice(prefix.length + 1);
    return matchesPattern(rest, '**/' + suffix) || matchesPattern(rest, suffix);
  }

  // dir/*.ext — single directory match
  if (pattern.includes('/') && pattern.includes('*.')) {
    const lastSlash = pattern.lastIndexOf('/');
    const dir = pattern.slice(0, lastSlash);
    const filePattern = pattern.slice(lastSlash + 1);
    const relDir = path.dirname(relativePath);
    const fileName = path.basename(relativePath);
    if (relDir !== dir) return false;
    if (filePattern.startsWith('*.')) {
      return fileName.endsWith(filePattern.slice(1));
    }
    return fileName === filePattern;
  }

  // Exact match
  return relativePath === pattern;
}

async function* walkFiles(
  dir: string,
  rootDir: string,
  ig: ReturnType<typeof ignore>
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

    if (ig.ignores(relativePath)) continue;

    if (entry.isDirectory()) {
      if (ig.ignores(relativePath + '/')) continue;
      yield* walkFiles(fullPath, rootDir, ig);
    } else if (entry.isFile()) {
      yield relativePath;
    }
  }
}

export const globHandler: ToolHandler = async (args, env) => {
  const pattern = args.pattern as string;
  const maxResults = (args.max_results as number | undefined) ?? 200;

  const rootDir = env.workspaceRoot;
  const ig = await loadGitignore(rootDir);
  const results: string[] = [];

  for await (const relativePath of walkFiles(rootDir, rootDir, ig)) {
    if (results.length >= maxResults) break;
    if (matchesPattern(relativePath, pattern)) {
      results.push(relativePath);
    }
  }

  results.sort();

  if (results.length === 0) {
    return `No files matching pattern '${pattern}'.`;
  }

  return results.join('\n');
};

export const globDescription = 'Find files matching a glob pattern in the workspace. Returns workspace-relative paths. Respects .gitignore.';
