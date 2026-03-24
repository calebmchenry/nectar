import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineEngine } from '../../src/engine/engine.js';
import type { RunEvent } from '../../src/engine/events.js';
import { hashDotSource, parseGardenSource } from '../../src/garden/parse.js';
import { validateGarden } from '../../src/garden/validate.js';
import { UnifiedClient } from '../../src/llm/client.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import { ScriptedAdapter } from '../helpers/scripted-adapter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nectar-pici-feedback-'));
  tempDirs.push(workspace);
  return workspace;
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const info = await stat(filePath);
    return info.size;
  } catch {
    return 0;
  }
}

describe('pici feedback integration regressions', () => {
  it('box+prompt runs with tools and creates output file', async () => {
    const workspace = await createWorkspace();
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      plan [shape=box, prompt="Write docs/plan.md", llm_provider="simulation"]
      done [shape=Msquare]
      start -> plan -> done
    }`);
    const adapter = new ScriptedAdapter([
      { tool_calls: [{ id: 'tc1', name: 'write_file', arguments: { path: 'docs/plan.md', content: '# Plan\\n' } }] },
      { text: 'Plan created.' },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'pici-box-tools',
      llm_client: client,
    });

    const result = await engine.run();
    expect(result.status).toBe('completed');
    const written = await readFile(path.join(workspace, 'docs', 'plan.md'), 'utf8');
    expect(written).toContain('# Plan');
  });

  it('zero-tool-call codergen fails and surfaces response text in node outcome notes', async () => {
    const workspace = await createWorkspace();
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      plan [shape=box, prompt="Write docs/plan.md", llm_provider="simulation"]
      done [shape=Msquare]
      start -> plan -> done
    }`);
    const adapter = new ScriptedAdapter([
      { text: 'I do not have access to the file system.' },
    ]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const events: RunEvent[] = [];

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'pici-zero-tool',
      llm_client: client,
    });
    engine.onEvent((event) => events.push(event));

    const result = await engine.run();
    expect(result.status).toBe('failed');

    const completion = events.find(
      (event): event is Extract<RunEvent, { type: 'node_completed' }> =>
        event.type === 'node_completed' && event.node_id === 'plan',
    );
    expect(completion?.outcome.status).toBe('failure');
    expect(completion?.outcome.notes).toContain('I do not have access to the file system.');
  });

  it('tool_command assert_exists fails when expected artifact is missing', async () => {
    const workspace = await createWorkspace();
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      build [shape=parallelogram, tool_command="echo done", assert_exists="docs/out.txt"]
      done [shape=Msquare]
      start -> build -> done
    }`);

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'pici-assert-missing',
    });

    const result = await engine.run();
    expect(result.status).toBe('failed');
  });

  it('tool_command assert_exists succeeds when expected artifact exists', async () => {
    const workspace = await createWorkspace();
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      build [shape=parallelogram, tool_command="mkdir -p docs && printf ok > docs/out.txt", assert_exists="docs/out.txt"]
      done [shape=Msquare]
      start -> build -> done
    }`);

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'pici-assert-present',
    });

    const result = await engine.run();
    expect(result.status).toBe('completed');
    const artifact = await readFile(path.join(workspace, 'docs', 'out.txt'), 'utf8');
    expect(artifact).toContain('ok');
  });

  it('rejects diamond+prompt during validation', async () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      gate [shape=diamond, prompt="Should we continue?"]
      done [shape=Msquare]
      start -> gate -> done
    }`);
    const diagnostics = validateGarden(graph);
    expect(diagnostics.some((diag) => diag.code === 'PROMPT_UNSUPPORTED_FOR_CONDITIONAL')).toBe(true);
  });

  it('stops branch sequence when predecessor fails', async () => {
    const workspace = await createWorkspace();
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      fan_out [shape=component]
      branch_a [shape=parallelogram, tool_command="exit 1"]
      branch_a_downstream [shape=parallelogram, tool_command="echo should-not-run > branch_a_downstream.txt"]
      branch_b [shape=parallelogram, tool_command="echo ok"]
      fan_in [shape=tripleoctagon]
      done [shape=Msquare]

      start -> fan_out
      fan_out -> branch_a
      fan_out -> branch_b
      branch_a -> branch_a_downstream
      branch_a_downstream -> fan_in
      branch_b -> fan_in
      fan_in -> done
    }`);

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'pici-branch-stop',
    });

    const result = await engine.run();
    expect(['completed', 'failed']).toContain(result.status);
    const downstreamArtifact = path.join(workspace, 'branch_a_downstream.txt');
    expect(await fileSize(downstreamArtifact)).toBe(0);
  });

  it('times out tool_command and kills spawned process tree', async () => {
    if (!['darwin', 'linux'].includes(process.platform)) {
      return;
    }

    const workspace = await createWorkspace();
    const heartbeatPath = path.join(workspace, 'timeout-heartbeat.log');
    const fixturePath = path.resolve('test/fixtures/process-tree.mjs');
    const command = `node ${JSON.stringify(fixturePath)} ${JSON.stringify(heartbeatPath)}`.replace(/"/g, '\\"');
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      slow [shape=parallelogram, timeout="250ms", tool_command="${command}"]
      done [shape=Msquare]
      start -> slow -> done
    }`);

    const engine = new PipelineEngine({
      graph,
      graph_hash: hashDotSource(graph.dotSource),
      workspace_root: workspace,
      run_id: 'pici-timeout',
    });

    const result = await engine.run();
    expect(result.status).toBe('failed');

    await new Promise((resolve) => setTimeout(resolve, 200));
    const sizeBefore = await fileSize(heartbeatPath);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const sizeAfter = await fileSize(heartbeatPath);
    expect(sizeAfter).toBe(sizeBefore);
  });
});
