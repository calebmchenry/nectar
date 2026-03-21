import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram } from '../../src/cli/index.js';
import { workspacePathsFromRoot, type WorkspacePaths } from '../../src/seedbed/paths.js';
import { SeedStore } from '../../src/seedbed/store.js';

const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
] as const;

let tempDir = '';
let ws: WorkspacePaths;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'nectar-swarm-cli-'));
  ws = workspacePathsFromRoot(tempDir);
  await mkdir(ws.seedbed, { recursive: true });
  await mkdir(ws.honey, { recursive: true });
  await mkdir(path.join(tempDir, 'gardens'), { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function captureOutput() {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  (process.stdout.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;

  (process.stderr.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stderr.write;

  return {
    restore() {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    },
    stdout() {
      return stdoutChunks.join('');
    },
    stderr() {
      return stderrChunks.join('');
    },
  };
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  process.chdir(tempDir);
  process.exitCode = 0;

  const capture = captureOutput();
  try {
    await createProgram().parseAsync(args, { from: 'user' });
  } finally {
    capture.restore();
    process.chdir(originalCwd);
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = originalExitCode;
  return {
    stdout: capture.stdout(),
    stderr: capture.stderr(),
    exitCode,
  };
}

describe('swarm CLI integration', () => {
  it('runs swarm analysis without server mode and writes provider output', async () => {
    const store = new SeedStore(ws);
    await store.create({ body: 'Run swarm locally' });

    const envSnapshot = new Map<string, string | undefined>();
    for (const key of PROVIDER_ENV_KEYS) {
      envSnapshot.set(key, process.env[key]);
      delete process.env[key];
    }

    try {
      const result = await runCli(['swarm', '1', '--provider', 'claude', '--force', '--no-attachments']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Running swarm analysis for seed 1');
      expect(result.stdout).toContain('claude: skipped');

      const seed = await store.get(1);
      expect(seed?.meta.analysis_status.claude).toBe('skipped');

      const analysisFiles = await readdir(path.join(seed!.dirPath, 'analysis'));
      expect(analysisFiles).toContain('claude.md');
    } finally {
      for (const key of PROVIDER_ENV_KEYS) {
        const previous = envSnapshot.get(key);
        if (previous === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous;
        }
      }
    }
  });
});
