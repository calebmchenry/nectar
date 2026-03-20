import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import type { ToolHandler } from '../tool-registry.js';

export const grepSchema = {
  properties: {
    pattern: { type: 'string', description: 'Regex pattern to search for' },
    path: { type: 'string', description: 'Subdirectory to search (relative to workspace root)' },
    include: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts")' },
    max_results: { type: 'integer', default: 200, description: 'Maximum number of results' },
  },
  required: ['pattern'],
  additionalProperties: false,
};

async function loadGitignore(dir: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();
  // Always ignore common directories
  ig.add(['.git', 'node_modules']);
  try {
    const content = await readFile(path.join(dir, '.gitignore'), 'utf8');
    ig.add(content);
  } catch {
    // No .gitignore — that's fine
  }
  return ig;
}

function matchesGlob(fileName: string, pattern: string): boolean {
  // Simple glob matching for common patterns like "*.ts", "*.js"
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1);
    return fileName.endsWith(ext);
  }
  if (pattern.startsWith('**/*.')) {
    const ext = pattern.slice(4); // e.g. ".ts"
    return fileName.endsWith(ext);
  }
  return fileName === pattern;
}

async function* walkFiles(
  dir: string,
  rootDir: string,
  ig: ReturnType<typeof ignore>,
  includePattern?: string
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
      // Also check if directory itself is ignored
      if (ig.ignores(relativePath + '/')) continue;
      yield* walkFiles(fullPath, rootDir, ig, includePattern);
    } else if (entry.isFile()) {
      if (includePattern && !matchesGlob(entry.name, includePattern)) continue;
      yield fullPath;
    }
  }
}

export const grepHandler: ToolHandler = async (args, env) => {
  const pattern = args.pattern as string;
  const searchPath = args.path as string | undefined;
  const include = args.include as string | undefined;
  const maxResults = (args.max_results as number | undefined) ?? 200;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    return `Error: Invalid regex pattern '${pattern}': ${(err as Error).message}`;
  }

  const rootDir = env.workspaceRoot;
  const startDir = searchPath
    ? await env.resolvePath(searchPath)
    : rootDir;

  const ig = await loadGitignore(rootDir);
  const results: string[] = [];

  for await (const filePath of walkFiles(startDir, rootDir, ig, include)) {
    if (results.length >= maxResults) break;

    try {
      const content = await readFile(filePath, 'utf8');

      // Quick binary check
      const checkSize = Math.min(content.length, 512);
      let isBinary = false;
      for (let i = 0; i < checkSize; i++) {
        if (content.charCodeAt(i) === 0) {
          isBinary = true;
          break;
        }
      }
      if (isBinary) continue;

      const lines = content.split('\n');
      const relPath = path.relative(rootDir, filePath);

      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxResults) break;
        if (regex.test(lines[i]!)) {
          results.push(`${relPath}:${i + 1}:${lines[i]}`);
        }
      }
    } catch {
      // Skip files we can't read
    }
  }

  if (results.length === 0) {
    return `No matches found for pattern '${pattern}'.`;
  }

  return results.join('\n');
};

export const grepDescription = 'Search files for a regex pattern. Returns file:line:content format. Respects .gitignore.';
