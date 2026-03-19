import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readCocoon } from '../../src/checkpoint/cocoon.js';
import { createProgram } from '../../src/cli/index.js';
import { PipelineEngine } from '../../src/engine/engine.js';
import { parseGardenFile } from '../../src/garden/parse.js';

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
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nectar-int-resume-'));
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

describe('integration resume', () => {
  it('creates a cocoon that can be used to resume a run', { timeout: 30_000 }, async () => {
    const workspace = await createWorkspace();
    // Run a simple pipeline to completion, then manually create a "partial" cocoon
    // to test the resume path without relying on process signal interception
    const dotContent = `digraph Resume {\nstart [shape=Mdiamond]\nstep1 [shape=parallelogram, script="echo step1"]\nstep2 [shape=parallelogram, script="echo step2"]\nend [shape=Msquare]\nstart -> step1\nstep1 -> step2\nstep2 -> end\n}`;
    const gardenPath = path.join(workspace, 'gardens', 'resume-test.dot');
    await writeFile(gardenPath, dotContent, 'utf8');

    const originalCwd = process.cwd();
    process.chdir(workspace);

    try {
      const graph = await parseGardenFile(gardenPath);

      // Manually create a cocoon as if the engine was interrupted after step1
      const { ensureCocoonRoot, writeCocoon } = await import('../../src/checkpoint/cocoon.js');
      await ensureCocoonRoot(workspace);

      const partialCocoon = {
        version: 1 as const,
        run_id: 'resume-test-run',
        dot_file: gardenPath,
        graph_hash: 'resume-hash',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'interrupted' as const,
        interruption_reason: 'SIGINT',
        completed_nodes: [
          { node_id: 'start', status: 'success' as const, started_at: new Date().toISOString(), completed_at: new Date().toISOString(), retries: 0 },
          { node_id: 'step1', status: 'success' as const, started_at: new Date().toISOString(), completed_at: new Date().toISOString(), retries: 0 }
        ],
        current_node: 'step2',
        context: {},
        retry_state: {}
      };

      await writeCocoon(partialCocoon, workspace);

      const cocoon = await readCocoon('resume-test-run', workspace);
      expect(cocoon?.status).toBe('interrupted');
      expect(cocoon?.current_node).toBe('step2');

      // Resume from the cocoon — should execute step2 and end
      const resumeEngine = new PipelineEngine({
        graph,
        graph_hash: 'resume-hash',
        workspace_root: workspace,
        initial_cocoon: cocoon ?? undefined
      });

      const resumed = await resumeEngine.run();
      expect(resumed.status).toBe('completed');

      // Verify the resumed cocoon includes all nodes
      const finalCocoon = await readCocoon('resume-test-run', workspace);
      expect(finalCocoon?.status).toBe('completed');
      const completedIds = finalCocoon?.completed_nodes.map((n) => n.node_id) ?? [];
      expect(completedIds).toContain('step2');
      expect(completedIds).toContain('end');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('resume errors on graph hash mismatch unless forced', async () => {
    const workspace = await createWorkspace();
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    process.chdir(workspace);
    process.exitCode = 0;

    try {
      await createProgram().parseAsync(['run', 'gardens/smoke-success.dot'], { from: 'user' });
      const cocoonFiles = await readdir(path.join(workspace, '.nectar', 'cocoons'));
      const runId = cocoonFiles.find((name) => name.endsWith('.json'))?.replace(/\.json$/, '');
      expect(runId).toBeTruthy();

      await writeFile(
        path.join(workspace, 'gardens', 'smoke-success.dot'),
        `digraph SmokeSuccess {\nstart [shape=Mdiamond]\nhello [shape=parallelogram, script="node scripts/compliance_loop.mjs draft --provider smoke"]\ndone [shape=Msquare]\nstart -> hello\nhello -> done\n// changed\n}`,
        'utf8'
      );

      process.exitCode = 0;
      const mismatchCapture = captureOutput();
      try {
        await createProgram().parseAsync(['resume', runId ?? ''], { from: 'user' });
      } finally {
        mismatchCapture.restore();
      }

      expect(process.exitCode).toBe(1);
      expect(mismatchCapture.stderr()).toContain('Graph hash mismatch');

      process.exitCode = 0;
      await createProgram().parseAsync(['resume', runId ?? '', '--force'], { from: 'user' });
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.exitCode = originalExitCode;
      process.chdir(originalCwd);
    }
  });
});
