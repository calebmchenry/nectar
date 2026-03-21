import { mkdir, readFile, readdir, realpath as fsRealpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ignore from 'ignore';
import { execaCommand } from 'execa';
import { runGlobSearch, runGrepSearch } from './search.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timed_out: boolean;
  duration_ms: number;
}

export interface ExecOptions {
  timeout_ms?: number;
  abort_signal?: AbortSignal;
}

export interface ExecutionEnvironment {
  readonly workspaceRoot: string;
  readonly cwd: string;
  initialize(): Promise<void>;
  cleanup(): Promise<void>;
  platform(): Promise<string>;
  os_version(): Promise<string>;
  list_directory(dirPath: string, depth?: number): Promise<string>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  fileExists(filePath: string): Promise<boolean>;
  deleteFile(filePath: string): Promise<void>;
  renameFile(srcPath: string, dstPath: string): Promise<void>;
  resolvePath(filePath: string): Promise<string>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  glob(pattern: string): Promise<string[]>;
  grep(pattern: string, options?: { path?: string; include?: string; maxResults?: number }): Promise<string[]>;
  scoped(subdir: string): ExecutionEnvironment;
}

const ENV_KEEP = new Set([
  'PATH',
  'HOME',
  'USER',
  'TMPDIR',
  'LANG',
  'CI',
  'NODE_ENV',
  'SHELL',
  'TERM',
  'GOPATH',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'NVM_DIR',
  'VOLTA_HOME',
  'PYENV_ROOT',
  'VIRTUAL_ENV',
  'PNPM_HOME',
  'ASDF_DIR',
]);

const ENV_KEEP_PREFIXES = ['LC_', 'NECTAR_'];
const ENV_DROP_SUFFIXES = ['_API_KEY', '_SECRET', '_TOKEN', '_PASSWORD'];
const ENV_DROP_CONTAINS = ['_CREDENTIAL'];

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }

    const upper = key.toUpperCase();
    if (ENV_DROP_SUFFIXES.some((suffix) => upper.endsWith(suffix))) {
      continue;
    }
    if (ENV_DROP_CONTAINS.some((pattern) => upper.includes(pattern))) {
      continue;
    }

    if (ENV_KEEP.has(key) || ENV_KEEP_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export class LocalExecutionEnvironment implements ExecutionEnvironment {
  readonly workspaceRoot: string;
  readonly cwd: string;
  private initialized = false;

  constructor(workspaceRoot: string, cwd?: string) {
    try {
      this.workspaceRoot = realpathSync(workspaceRoot);
    } catch {
      this.workspaceRoot = workspaceRoot;
    }
    this.cwd = cwd ?? this.workspaceRoot;
  }

  static async create(workspaceRoot: string): Promise<LocalExecutionEnvironment> {
    const resolved = await fsRealpath(workspaceRoot);
    return new LocalExecutionEnvironment(resolved);
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async cleanup(): Promise<void> {
    this.initialized = false;
  }

  async platform(): Promise<string> {
    return process.platform;
  }

  async os_version(): Promise<string> {
    return os.release();
  }

  async resolvePath(filePath: string): Promise<string> {
    const absolute = path.isAbsolute(filePath) ? filePath : path.join(this.cwd, filePath);
    const normalized = path.normalize(absolute);

    if (!normalized.startsWith(this.workspaceRoot + path.sep) && normalized !== this.workspaceRoot) {
      throw new Error(`Path '${filePath}' resolves outside workspace root.`);
    }

    try {
      const real = await fsRealpath(normalized);
      if (!real.startsWith(this.workspaceRoot + path.sep) && real !== this.workspaceRoot) {
        throw new Error(`Path '${filePath}' resolves outside workspace root via symlink.`);
      }
      return real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return normalized;
      }
      throw error;
    }
  }

  async readFile(filePath: string): Promise<string> {
    const resolved = await this.resolvePath(filePath);
    return readFile(resolved, 'utf8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const resolved = await this.resolvePath(filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, 'utf8');
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      const resolved = await this.resolvePath(filePath);
      await stat(resolved);
      return true;
    } catch {
      return false;
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    const resolved = await this.resolvePath(filePath);
    await unlink(resolved);
  }

  async renameFile(srcPath: string, dstPath: string): Promise<void> {
    const resolvedSrc = await this.resolvePath(srcPath);
    const resolvedDst = await this.resolvePath(dstPath);
    await mkdir(path.dirname(resolvedDst), { recursive: true });
    await rename(resolvedSrc, resolvedDst);
  }

  async list_directory(dirPath: string, depth = 1): Promise<string> {
    const boundedDepth = Math.max(0, Math.min(8, depth));
    const absolute = await this.resolvePath(dirPath);
    const info = await stat(absolute);
    if (!info.isDirectory()) {
      return `Error: '${dirPath}' is not a directory.`;
    }

    const ig = await loadGitignore(this.workspaceRoot);
    const displayRoot = path.relative(this.workspaceRoot, absolute) || '.';
    const lines = [`${displayRoot}/`];

    const listed = await walkDirectory({
      absoluteRoot: this.workspaceRoot,
      directory: absolute,
      depth: boundedDepth,
      ig,
      currentDepth: 0,
    });

    if (listed.length === 0) {
      lines.push('  (empty)');
    } else {
      lines.push(...listed);
    }
    return lines.join('\n');
  }

  scoped(subdir: string): ExecutionEnvironment {
    const newCwd = path.isAbsolute(subdir) ? subdir : path.join(this.cwd, subdir);
    const normalized = path.normalize(newCwd);
    if (!normalized.startsWith(this.workspaceRoot + path.sep) && normalized !== this.workspaceRoot) {
      throw new Error(`Cannot scope to '${subdir}': resolves outside workspace root.`);
    }
    return new LocalExecutionEnvironment(this.workspaceRoot, normalized);
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const timeoutMs = options?.timeout_ms ?? 120_000;
    const filteredEnv = filterEnv(process.env);
    const startedMs = Date.now();

    try {
      const result = await execaCommand(command, {
        cwd: this.cwd,
        env: filteredEnv,
        extendEnv: false,
        timeout: timeoutMs,
        shell: true,
        killSignal: 'SIGTERM',
        forceKillAfterDelay: 2000,
        reject: false,
        cancelSignal: options?.abort_signal,
      });

      return {
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
        exitCode: (result as unknown as { timedOut?: boolean }).timedOut ? 124 : (result.exitCode ?? 0),
        timed_out: Boolean((result as unknown as { timedOut?: boolean }).timedOut),
        duration_ms: Math.max(0, Date.now() - startedMs),
      };
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'timedOut' in error && (error as { timedOut: boolean }).timedOut) {
        return {
          stdout: String((error as { stdout?: unknown }).stdout ?? ''),
          stderr: String((error as { stderr?: unknown }).stderr ?? ''),
          exitCode: 124,
          timed_out: true,
          duration_ms: Math.max(0, Date.now() - startedMs),
        };
      }

      if (error && typeof error === 'object' && 'isCanceled' in error && (error as { isCanceled: boolean }).isCanceled) {
        return {
          stdout: String((error as { stdout?: unknown }).stdout ?? ''),
          stderr: 'Command cancelled',
          exitCode: 130,
          timed_out: false,
          duration_ms: Math.max(0, Date.now() - startedMs),
        };
      }

      throw error;
    }
  }

  async glob(pattern: string): Promise<string[]> {
    return runGlobSearch(this, pattern);
  }

  async grep(pattern: string, options?: { path?: string; include?: string; maxResults?: number }): Promise<string[]> {
    const matches = await runGrepSearch(this, pattern, {
      path: options?.path,
      include: options?.include,
      maxResults: options?.maxResults,
    });
    return matches.map((match) => `${match.relative_path}:${match.line}:${match.content}`);
  }
}

async function loadGitignore(root: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();
  ig.add(['.git', 'node_modules']);
  try {
    const content = await readFile(path.join(root, '.gitignore'), 'utf8');
    ig.add(content);
  } catch {
    // Missing .gitignore is fine.
  }
  return ig;
}

async function walkDirectory(input: {
  absoluteRoot: string;
  directory: string;
  depth: number;
  ig: ReturnType<typeof ignore>;
  currentDepth: number;
}): Promise<string[]> {
  const entries = await readdir(input.directory, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) {
      return -1;
    }
    if (!a.isDirectory() && b.isDirectory()) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(input.directory, entry.name);
    const relativePath = path.relative(input.absoluteRoot, absolutePath);
    const ignorePath = entry.isDirectory() ? `${relativePath}/` : relativePath;
    if (input.ig.ignores(ignorePath)) {
      continue;
    }

    const indent = '  '.repeat(input.currentDepth + 1);
    lines.push(`${indent}${entry.name}${entry.isDirectory() ? '/' : ''}`);

    if (entry.isDirectory() && input.currentDepth < input.depth - 1) {
      const nested = await walkDirectory({
        absoluteRoot: input.absoluteRoot,
        directory: absolutePath,
        depth: input.depth,
        ig: input.ig,
        currentDepth: input.currentDepth + 1,
      });
      lines.push(...nested);
    }
  }

  return lines;
}

export { filterEnv as _filterEnvForTest };
