import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readCocoon } from '../../src/checkpoint/cocoon.js';
import { createProgram } from '../../src/cli/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nectar-int-run-'));
  tempDirs.push(workspace);
  await mkdir(path.join(workspace, 'scripts'), { recursive: true });
  await mkdir(path.join(workspace, 'gardens'), { recursive: true });
  await copyFile(path.join(ROOT, 'scripts', 'compliance_loop.mjs'), path.join(workspace, 'scripts', 'compliance_loop.mjs'));
  await copyFile(
    path.join(ROOT, 'test', 'fixtures', 'smoke-success.dot'),
    path.join(workspace, 'gardens', 'smoke-success.dot')
  );
  return workspace;
}

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
    stdout: () => stdoutChunks.join(''),
    stderr: () => stderrChunks.join('')
  };
}

describe('integration run', () => {
  it('runs smoke-success via CLI and writes a completed cocoon', async () => {
    const workspace = await createWorkspace();
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;

    process.chdir(workspace);
    process.exitCode = 0;

    const capture = captureOutput();

    try {
      await createProgram().parseAsync(['run', 'gardens/smoke-success.dot'], { from: 'user' });
    } finally {
      capture.restore();
      process.chdir(originalCwd);
    }

    expect(process.exitCode ?? 0).toBe(0);

    const cocoonDir = path.join(workspace, '.nectar', 'cocoons');
    const files = await import('node:fs/promises').then(({ readdir }) => readdir(cocoonDir));
    const runId = files.find((name) => name.endsWith('.json'))?.replace(/\.json$/, '');
    expect(runId).toBeTruthy();

    const cocoon = await readCocoon(runId ?? '', workspace);
    expect(cocoon?.status).toBe('completed');

    process.exitCode = originalExitCode;
  });

  it('validate reports file:line:col diagnostics for invalid graphs', async () => {
    const workspace = await createWorkspace();
    const invalidDotPath = path.join(workspace, 'gardens', 'invalid.dot');
    await writeFile(
      invalidDotPath,
      `digraph Invalid {\nstart [shape=Mdiamond]\nboxy [shape=box]\nend [shape=Msquare]\nstart -> boxy\nboxy -> end\n}`,
      'utf8'
    );

    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    process.chdir(workspace);
    process.exitCode = 0;

    const capture = captureOutput();
    try {
      await createProgram().parseAsync(['validate', 'gardens/invalid.dot'], { from: 'user' });
    } finally {
      capture.restore();
      process.chdir(originalCwd);
    }

    expect(process.exitCode).toBe(1);
    expect(capture.stderr()).toMatch(/gardens\/invalid\.dot:\d+:\d+/);

    process.exitCode = originalExitCode;
  });

  it('disables ANSI colors when stdout is piped', async () => {
    const workspace = await createWorkspace();
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    const originalIsTTY = process.stdout.isTTY;

    process.chdir(workspace);
    process.exitCode = 0;

    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false
    });

    const capture = captureOutput();
    try {
      await createProgram().parseAsync(['run', 'gardens/smoke-success.dot'], { from: 'user' });
    } finally {
      capture.restore();
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: originalIsTTY
      });
      process.chdir(originalCwd);
    }

    expect(capture.stdout()).not.toMatch(/\u001b\[/);

    process.exitCode = originalExitCode;
  });
});
