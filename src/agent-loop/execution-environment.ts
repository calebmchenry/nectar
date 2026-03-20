import { readFile, writeFile, mkdir, stat, unlink, rename, realpath as fsRealpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { execaCommand } from 'execa';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  timeout_ms?: number;
  abort_signal?: AbortSignal;
}

export interface ExecutionEnvironment {
  readonly workspaceRoot: string;
  readonly cwd: string;
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

/** Environment variable names to keep (allowlist prefixes/exact matches) */
const ENV_KEEP = new Set([
  'PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'CI', 'NODE_ENV', 'SHELL', 'TERM',
]);

const ENV_KEEP_PREFIXES = ['LC_', 'NECTAR_'];

/** Environment variable patterns to drop (sensitive) */
const ENV_DROP_SUFFIXES = ['_API_KEY', '_SECRET', '_TOKEN', '_PASSWORD'];
const ENV_DROP_CONTAINS = ['_CREDENTIAL'];

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;

    // Drop sensitive vars
    const upper = key.toUpperCase();
    if (ENV_DROP_SUFFIXES.some((s) => upper.endsWith(s))) continue;
    if (ENV_DROP_CONTAINS.some((c) => upper.includes(c))) continue;

    // Keep allowed vars
    if (ENV_KEEP.has(key)) {
      filtered[key] = value;
      continue;
    }
    if (ENV_KEEP_PREFIXES.some((p) => key.startsWith(p))) {
      filtered[key] = value;
      continue;
    }
  }
  return filtered;
}

export class LocalExecutionEnvironment implements ExecutionEnvironment {
  readonly workspaceRoot: string;
  readonly cwd: string;

  constructor(workspaceRoot: string, cwd?: string) {
    // Resolve symlinks at creation time (e.g. /tmp -> /private/var/... on macOS)
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

  async resolvePath(filePath: string): Promise<string> {
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.cwd, filePath);

    // Normalize to resolve .. and .
    const normalized = path.normalize(absolute);

    // Check if the normalized path is inside workspace
    if (!normalized.startsWith(this.workspaceRoot + path.sep) && normalized !== this.workspaceRoot) {
      throw new Error(`Path '${filePath}' resolves outside workspace root.`);
    }

    // If the file exists, check the realpath (catches symlink escapes)
    try {
      const real = await fsRealpath(normalized);
      if (!real.startsWith(this.workspaceRoot + path.sep) && real !== this.workspaceRoot) {
        throw new Error(`Path '${filePath}' resolves outside workspace root via symlink.`);
      }
      return real;
    } catch (err) {
      // File doesn't exist yet — that's OK for writes
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return normalized;
      }
      throw err;
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

  scoped(subdir: string): ExecutionEnvironment {
    const newCwd = path.isAbsolute(subdir)
      ? subdir
      : path.join(this.cwd, subdir);
    const normalized = path.normalize(newCwd);
    if (!normalized.startsWith(this.workspaceRoot + path.sep) && normalized !== this.workspaceRoot) {
      throw new Error(`Cannot scope to '${subdir}': resolves outside workspace root.`);
    }
    return new LocalExecutionEnvironment(this.workspaceRoot, normalized);
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const timeoutMs = options?.timeout_ms ?? 120_000;
    const filteredEnv = filterEnv(process.env);

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
        exitCode: result.exitCode ?? 0,
      };
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'timedOut' in err && (err as { timedOut: boolean }).timedOut) {
        return {
          stdout: String((err as { stdout?: unknown }).stdout ?? ''),
          stderr: String((err as { stderr?: unknown }).stderr ?? ''),
          exitCode: 124,
        };
      }
      // Cancelled via abort
      if (err && typeof err === 'object' && 'isCanceled' in err && (err as { isCanceled: boolean }).isCanceled) {
        return {
          stdout: String((err as { stdout?: unknown }).stdout ?? ''),
          stderr: 'Command cancelled',
          exitCode: 130,
        };
      }
      throw err;
    }
  }

  async glob(_pattern: string): Promise<string[]> {
    // Implemented by the glob tool, not directly by the environment
    throw new Error('Use the glob tool instead');
  }

  async grep(_pattern: string, _options?: { path?: string; include?: string; maxResults?: number }): Promise<string[]> {
    // Implemented by the grep tool, not directly by the environment
    throw new Error('Use the grep tool instead');
  }
}

export { filterEnv as _filterEnvForTest };
