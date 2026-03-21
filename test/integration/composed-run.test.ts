import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineService } from '../../src/runtime/pipeline-service.js';
import { AutoApproveInterviewer } from '../../src/interviewer/auto-approve.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-composed-run-'));
  tempDirs.push(dir);
  await mkdir(path.join(dir, 'gardens', 'lib'), { recursive: true });
  return dir;
}

describe('composed runtime integration', () => {
  it('executes a composed garden end-to-end and persists prepared artifacts', async () => {
    const workspace = await createWorkspace();
    const parentPath = path.join(workspace, 'gardens', 'release.dot');
    const childPath = path.join(workspace, 'gardens', 'lib', 'review-loop.dot');

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

    await writeFile(
      parentPath,
      `digraph Release {
        start [shape=Mdiamond]
        review_loop [shape=component, "compose.dotfile"="lib/review-loop.dot"]
        post [shape=parallelogram, script="echo post"]
        done [shape=Msquare]
        start -> review_loop -> post -> done
      }`,
      'utf8',
    );

    const service = new PipelineService(workspace);
    const load = await service.loadFromPath('gardens/release.dot');
    expect(load.graph).toBeTruthy();
    expect(load.graph_hash_kind).toBe('prepared');
    expect(load.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toHaveLength(0);

    const runResult = await service.executePipeline({
      graph: load.graph!,
      graph_hash: load.graph_hash ?? '',
      graph_hash_kind: load.graph_hash_kind,
      prepared_dot: load.prepared_dot,
      source_files: load.source_files,
      interviewer: new AutoApproveInterviewer(),
      register_signal_handlers: false,
    });

    expect(runResult.status).toBe('completed');
    const completedIds = runResult.completed_nodes.map((node) => node.node_id);
    expect(completedIds).toContain('post');
    expect(completedIds).toContain('done');
    expect(completedIds).toContain('review_loop__child_done');

    const runDir = path.join(workspace, '.nectar', 'cocoons', runResult.run_id);
    const preparedDot = await readFile(path.join(runDir, 'prepared.dot'), 'utf8');
    expect(preparedDot).toContain('review_loop__child_work');

    const sourceManifest = JSON.parse(
      await readFile(path.join(runDir, 'source-manifest.json'), 'utf8'),
    ) as {
      graph_hash_kind?: string;
      graph_hash?: string;
      source_files?: string[];
    };
    expect(sourceManifest.graph_hash_kind).toBe('prepared');
    expect(sourceManifest.graph_hash).toBe(load.graph_hash);
    expect(sourceManifest.source_files?.sort()).toEqual([
      path.join(workspace, 'gardens', 'lib', 'review-loop.dot'),
      path.join(workspace, 'gardens', 'release.dot'),
    ]);
  });
});
