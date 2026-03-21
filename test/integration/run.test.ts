import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readCocoon } from '../../src/checkpoint/cocoon.js';
import { createProgram } from '../../src/cli/index.js';
import { PipelineEngine } from '../../src/engine/engine.js';
import { RunEvent } from '../../src/engine/events.js';
import { parseGardenFile, parseGardenSource, hashDotSource } from '../../src/garden/parse.js';
import { QueueInterviewer } from '../../src/interviewer/queue.js';
import { AutoApproveInterviewer } from '../../src/interviewer/auto-approve.js';

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
      `digraph Invalid {\nstart [shape=Mdiamond]\nboxy [shape=octagon]\nend [shape=Msquare]\nstart -> boxy\nboxy -> end\n}`,
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

  it('runs human-gate pipeline end-to-end with QueueInterviewer selecting non-first edge', async () => {
    const workspace = await createWorkspace();
    const fixturePath = path.join(ROOT, 'test', 'fixtures', 'human-gate.dot');
    const gardenPath = path.join(workspace, 'gardens', 'human-gate.dot');
    await copyFile(fixturePath, gardenPath);

    const originalCwd = process.cwd();
    process.chdir(workspace);

    try {
      const graph = await parseGardenFile(gardenPath);
      // Select "[R] Reject" — the non-first edge
      const interviewer = new QueueInterviewer([{ selected_label: '[R] Reject', source: 'queue' }]);
      const events: RunEvent[] = [];

      const engine = new PipelineEngine({
        graph,
        graph_hash: hashDotSource(graph.dotSource),
        workspace_root: workspace,
        run_id: 'human-gate-run',
        interviewer
      });
      engine.onEvent((e) => events.push(e));

      const result = await engine.run();
      expect(result.status).toBe('completed');

      // Verify we took the reject path, not the deploy path
      const completedIds = result.completed_nodes.map((n) => n.node_id);
      expect(completedIds).toContain('reject');
      expect(completedIds).not.toContain('deploy');

      // Verify human_question and human_answer events were emitted
      expect(events.some((e) => e.type === 'human_question')).toBe(true);
      expect(events.some((e) => e.type === 'human_answer')).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('runs human-gate pipeline with --auto-approve selecting first edge', async () => {
    const workspace = await createWorkspace();
    const fixturePath = path.join(ROOT, 'test', 'fixtures', 'human-gate.dot');
    const gardenPath = path.join(workspace, 'gardens', 'human-gate.dot');
    await copyFile(fixturePath, gardenPath);

    const originalCwd = process.cwd();
    process.chdir(workspace);

    try {
      const graph = await parseGardenFile(gardenPath);
      const interviewer = new AutoApproveInterviewer();

      const engine = new PipelineEngine({
        graph,
        graph_hash: hashDotSource(graph.dotSource),
        workspace_root: workspace,
        run_id: 'auto-approve-run',
        interviewer
      });

      const result = await engine.run();
      expect(result.status).toBe('completed');

      // Auto-approve selects first choice "[A] Approve" → deploy path
      const completedIds = result.completed_nodes.map((n) => n.node_id);
      expect(completedIds).toContain('deploy');
      expect(completedIds).toContain('done');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('runs interactive-approval sample garden with QueueInterviewer', async () => {
    const workspace = await createWorkspace();
    const gardenSrc = path.join(ROOT, 'gardens', 'interactive-approval.dot');
    const gardenPath = path.join(workspace, 'gardens', 'interactive-approval.dot');
    await copyFile(gardenSrc, gardenPath);

    const originalCwd = process.cwd();
    process.chdir(workspace);

    try {
      const graph = await parseGardenFile(gardenPath);
      // Select "[A] Approve" to go through deploy → done
      const interviewer = new QueueInterviewer([{ selected_label: '[A] Approve', source: 'queue' }]);

      const engine = new PipelineEngine({
        graph,
        graph_hash: hashDotSource(graph.dotSource),
        workspace_root: workspace,
        run_id: 'sample-garden-run',
        interviewer
      });

      const result = await engine.run();
      expect(result.status).toBe('completed');
      const completedIds = result.completed_nodes.map((n) => n.node_id);
      expect(completedIds).toContain('deploy');
      expect(completedIds).toContain('done');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('runs interactive-approval with --auto-approve via CLI', async () => {
    const workspace = await createWorkspace();
    const gardenSrc = path.join(ROOT, 'gardens', 'interactive-approval.dot');
    const gardenPath = path.join(workspace, 'gardens', 'interactive-approval.dot');
    await copyFile(gardenSrc, gardenPath);

    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    process.chdir(workspace);
    process.exitCode = 0;

    const capture = captureOutput();
    try {
      await createProgram().parseAsync(['run', '--auto-approve', 'gardens/interactive-approval.dot'], { from: 'user' });
    } finally {
      capture.restore();
      process.chdir(originalCwd);
    }

    expect(process.exitCode ?? 0).toBe(0);
    process.exitCode = originalExitCode;
  });

  it('non-TTY with human.default_choice auto-selects', async () => {
    const workspace = await createWorkspace();
    const fixturePath = path.join(ROOT, 'test', 'fixtures', 'human-timeout.dot');
    const gardenPath = path.join(workspace, 'gardens', 'human-timeout.dot');
    await copyFile(fixturePath, gardenPath);

    const originalCwd = process.cwd();
    process.chdir(workspace);

    // ConsoleInterviewer will detect non-TTY and use default_choice="skip"
    // We simulate by using the engine directly with a ConsoleInterviewer-like behavior
    // The ConsoleInterviewer checks process.stdin.isTTY — in test environment this is typically false
    const { ConsoleInterviewer } = await import('../../src/interviewer/console.js');

    try {
      const graph = await parseGardenFile(gardenPath);
      const interviewer = new ConsoleInterviewer();

      const engine = new PipelineEngine({
        graph,
        graph_hash: hashDotSource(graph.dotSource),
        workspace_root: workspace,
        run_id: 'non-tty-default-run',
        interviewer
      });

      const result = await engine.run();
      expect(result.status).toBe('completed');

      // In non-TTY, ConsoleInterviewer should auto-select "skip" (the default_choice)
      const completedIds = result.completed_nodes.map((n) => n.node_id);
      expect(completedIds).toContain('skip');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('non-TTY without human.default_choice fails gracefully', async () => {
    const workspace = await createWorkspace();
    const fixturePath = path.join(ROOT, 'test', 'fixtures', 'human-gate.dot');
    const gardenPath = path.join(workspace, 'gardens', 'human-gate.dot');
    await copyFile(fixturePath, gardenPath);

    const originalCwd = process.cwd();
    process.chdir(workspace);

    const { ConsoleInterviewer } = await import('../../src/interviewer/console.js');

    try {
      const graph = await parseGardenFile(gardenPath);
      // human-gate.dot has no human.default_choice, so ConsoleInterviewer in non-TTY should fail
      const interviewer = new ConsoleInterviewer();

      const engine = new PipelineEngine({
        graph,
        graph_hash: hashDotSource(graph.dotSource),
        workspace_root: workspace,
        run_id: 'non-tty-fail-run',
        interviewer
      });

      const result = await engine.run();
      // The WaitHumanHandler catches the error and returns failure
      // Then the engine should fail because no edge matches 'failure' status from the human gate
      // or the run completes with a failed node
      const approvalNode = result.completed_nodes.find((n) => n.node_id === 'approval');
      expect(approvalNode?.status).toBe('failure');
    } finally {
      process.chdir(originalCwd);
    }
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
