import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineConflictError, PipelineService } from '../../src/runtime/pipeline-service.js';
import { AutoApproveInterviewer } from '../../src/interviewer/auto-approve.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-composed-resume-'));
  tempDirs.push(dir);
  await mkdir(path.join(dir, 'gardens', 'lib'), { recursive: true });
  return dir;
}

async function writeParent(workspace: string): Promise<void> {
  await writeFile(
    path.join(workspace, 'gardens', 'release.dot'),
    `digraph Release {
      start [shape=Mdiamond]
      review_loop [shape=component, "compose.dotfile"="lib/review-loop.dot"]
      done [shape=Msquare]
      start -> review_loop -> done
    }`,
    'utf8',
  );
}

async function writeChild(workspace: string, variant: 'base' | 'semantic-change' | 'whitespace-only'): Promise<void> {
  const childPath = path.join(workspace, 'gardens', 'lib', 'review-loop.dot');
  if (variant === 'base') {
    await writeFile(
      childPath,
      `digraph ReviewLoop {
        child_start [shape=Mdiamond]
        child_work [shape=parallelogram, script="echo child"]
        child_done [shape=Msquare]
        child_start -> child_work -> child_done
      }`,
      'utf8',
    );
    return;
  }

  if (variant === 'semantic-change') {
    await writeFile(
      childPath,
      `digraph ReviewLoop {
        child_start [shape=Mdiamond]
        child_work [shape=parallelogram, script="echo changed"]
        child_done [shape=Msquare]
        child_start -> child_work -> child_done
      }`,
      'utf8',
    );
    return;
  }

  await writeFile(
    childPath,
    `digraph ReviewLoop {
      /* formatting-only change */

      child_start [shape=Mdiamond]
      child_work [shape=parallelogram, script="echo child"]
      child_done [shape=Msquare]

      child_start -> child_work
      child_work -> child_done
    }`,
    'utf8',
  );
}

async function runBasePipeline(service: PipelineService): Promise<string> {
  const load = await service.loadFromPath('gardens/release.dot');
  expect(load.graph).toBeTruthy();
  expect(load.graph_hash_kind).toBe('prepared');
  expect(load.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toHaveLength(0);

  const run = await service.executePipeline({
    graph: load.graph!,
    graph_hash: load.graph_hash ?? '',
    graph_hash_kind: load.graph_hash_kind,
    prepared_dot: load.prepared_dot,
    source_files: load.source_files,
    interviewer: new AutoApproveInterviewer(),
    register_signal_handlers: false,
  });
  expect(run.status).toBe('completed');
  return run.run_id;
}

describe('composed resume integration', () => {
  it('rejects semantic changes in imported child graphs', async () => {
    const workspace = await createWorkspace();
    await writeParent(workspace);
    await writeChild(workspace, 'base');
    const service = new PipelineService(workspace);
    const runId = await runBasePipeline(service);

    await writeChild(workspace, 'semantic-change');

    await expect(service.resumePipeline({ run_id: runId })).rejects.toBeInstanceOf(PipelineConflictError);
  });

  it('accepts whitespace-only or comment-only child edits', async () => {
    const workspace = await createWorkspace();
    await writeParent(workspace);
    await writeChild(workspace, 'base');
    const service = new PipelineService(workspace);
    const runId = await runBasePipeline(service);

    await writeChild(workspace, 'whitespace-only');

    const resumed = await service.resumePipeline({ run_id: runId });
    expect(resumed.run_result.status).toBe('completed');
    expect(resumed.graph_hash_kind).toBe('prepared');
  });
});
