import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/engine/events.js';
import { PipelineEngine } from '../../src/engine/engine.js';
import { hashDotSource, parseGardenFile, parseGardenSource } from '../../src/garden/parse.js';
import { RunStore } from '../../src/checkpoint/run-store.js';

const tempDirs: string[] = [];
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-int-conditions-'));
  tempDirs.push(dir);
  return dir;
}

describe('integration rich conditions', () => {
  it('routes through > and CONTAINS conditions', async () => {
    const workspace = await createWorkspace();
    const source = `digraph G {
      start [shape=Mdiamond]
      review [shape=parallelogram, tool_command="echo approved by reviewer"]
      route [shape=diamond]
      deploy [shape=parallelogram, tool_command="echo deploy"]
      revise [shape=parallelogram, tool_command="echo revise"]
      done [shape=Msquare]

      start -> review
      review -> route
      route -> deploy [condition="context.coverage > 80 && steps.review.output CONTAINS approved"]
      route -> revise [label="Fallback"]
      deploy -> done
      revise -> done
    }`;

    const graph = parseGardenSource(source, path.join(workspace, 'gardens', 'rich-conditions.dot'));
    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'rich-conditions-run',
      initial_context: { coverage: '85' },
    });

    const result = await engine.run();
    expect(result.status).toBe('completed');
    const completedIds = result.completed_nodes.map((node) => node.node_id);
    expect(completedIds).toContain('deploy');
    expect(completedIds).not.toContain('revise');

    const cocoon = await RunStore.readCocoon('rich-conditions-run', workspace);
    expect(cocoon?.step_results?.['review']?.output_preview).toContain('approved');
  });

  it('retries failure once then routes via retry_target fixture', async () => {
    const workspace = await createWorkspace();
    const graph = await parseGardenFile(path.join(ROOT, 'test', 'fixtures', 'retry-failure-routing.dot'));
    const runId = 'retry-failure-routing-run';
    const events: RunEvent[] = [];

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: runId,
    });
    engine.onEvent((event) => events.push(event));

    const result = await engine.run();
    expect(result.status).toBe('failed');

    const retryEvents = events.filter((event): event is Extract<RunEvent, { type: 'node_retrying' }> => event.type === 'node_retrying');
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]?.node_id).toBe('unstable');

    const completedIds = result.completed_nodes.map((node) => node.node_id);
    expect(completedIds).toContain('recover');
    expect(completedIds).toContain('done');

    const unstableCompletion = result.completed_nodes.find((node) => node.node_id === 'unstable');
    expect(unstableCompletion?.retries).toBe(1);

    const cocoon = await RunStore.readCocoon(runId, workspace);
    expect(cocoon?.status).toBe('failed');
  });
});
