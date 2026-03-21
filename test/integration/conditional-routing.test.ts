import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineEngine } from '../../src/engine/engine.js';
import { hashDotSource, parseGardenSource } from '../../src/garden/parse.js';
import { RunStore } from '../../src/checkpoint/run-store.js';
import type { Cocoon } from '../../src/checkpoint/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-int-conditional-routing-'));
  tempDirs.push(dir);
  return dir;
}

const ROUTING_SOURCE = `digraph G {
  start [shape=Mdiamond]
  score [shape=parallelogram, tool_command="printf 85"]
  review [shape=parallelogram, tool_command="printf artifact-ready"]
  gate [shape=diamond]
  ok_exit [shape=Msquare]
  fail_exit [shape=Msquare]

  start -> score
  score -> review
  review -> gate
  gate -> ok_exit [condition="steps.score.output > 80 && steps.review.output CONTAINS artifact && EXISTS artifacts.review.stdout"]
  gate -> fail_exit [label="Fallback"]
}`;

describe('integration conditional routing', () => {
  it('resolves steps.* and artifacts.* during fresh execution', async () => {
    const workspace = await createWorkspace();
    const graph = parseGardenSource(ROUTING_SOURCE, path.join(workspace, 'gardens', 'fresh.dot'));
    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'fresh-routing-run',
    });

    const result = await engine.run();
    expect(result.status).toBe('completed');
    const completedIds = result.completed_nodes.map((node) => node.node_id);
    expect(completedIds).toContain('ok_exit');
    expect(completedIds).not.toContain('fail_exit');
  });

  it('resolves steps.* and artifacts.* correctly after resume', async () => {
    const workspace = await createWorkspace();
    const graph = parseGardenSource(ROUTING_SOURCE, path.join(workspace, 'gardens', 'resume.dot'));
    const runId = 'resume-routing-run';
    const graphHash = hashDotSource(graph.dotSource);
    const now = new Date().toISOString();

    const store = new RunStore(runId, workspace);
    await store.initialize({
      run_id: runId,
      dot_file: graph.dotPath,
      graph_hash: graphHash,
      started_at: now,
      workspace_root: workspace,
    });

    const scoreArtifactId = store.nextArtifactId('score', 'stdout');
    await store.artifactStore().store(scoreArtifactId, 'score.stdout', '85');
    const reviewArtifactId = store.nextArtifactId('review', 'stdout');
    await store.artifactStore().store(reviewArtifactId, 'review.stdout', 'artifact-ready');

    const cocoon: Cocoon = {
      version: 1,
      run_id: runId,
      dot_file: graph.dotPath,
      graph_hash: graphHash,
      started_at: now,
      updated_at: now,
      status: 'interrupted',
      interruption_reason: 'SIGINT',
      completed_nodes: [
        {
          node_id: 'start',
          status: 'success',
          started_at: now,
          completed_at: now,
          retries: 0,
        },
        {
          node_id: 'score',
          status: 'success',
          started_at: now,
          completed_at: now,
          retries: 0,
        },
        {
          node_id: 'review',
          status: 'success',
          started_at: now,
          completed_at: now,
          retries: 0,
        },
      ],
      current_node: 'gate',
      context: {
        'score.stdout': '85',
        'review.stdout': 'artifact-ready',
        outcome: 'success',
      },
      retry_state: {},
      step_results: undefined,
      artifact_aliases: {
        'score.stdout': scoreArtifactId,
        'review.stdout': reviewArtifactId,
      },
    };

    await store.writeCheckpoint(cocoon);
    await store.writeLegacyMirror(cocoon);

    const resumeEngine = new PipelineEngine({
      graph,
      graph_hash: graphHash,
      workspace_root: workspace,
      initial_cocoon: cocoon,
    });

    const resumed = await resumeEngine.run();
    expect(resumed.status).toBe('completed');
    const completedIds = resumed.completed_nodes.map((node) => node.node_id);
    expect(completedIds).toContain('ok_exit');
    expect(completedIds).not.toContain('fail_exit');
  });
});
