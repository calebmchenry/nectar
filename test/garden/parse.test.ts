import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGardenFile, parseGardenSource, normalizeClassName } from '../../src/garden/parse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

describe('garden parse', () => {
  it('parses compliance-loop graph', async () => {
    const graph = await parseGardenFile(path.join(ROOT, 'test', 'fixtures', 'compliance-loop.dot'));

    expect(graph.nodes).toHaveLength(14);
    expect(graph.edges).toHaveLength(17);

    const implement = graph.nodeMap.get('implement');
    expect(implement?.kind).toBe('tool');
    expect(implement?.maxRetries).toBe(2);
    expect(implement?.attributes.script).toContain('node scripts/compliance_loop.mjs implement');

    const fallbackEdge = graph.edges.find(
      (edge) => edge.source === 'compliance_check' && edge.target === 'claude_draft' && edge.label === 'Fallback'
    );
    expect(fallbackEdge).toBeTruthy();
  });

  it('normalizes chained edges into individual edges', () => {
    const graph = parseGardenSource(`digraph T { start [shape=Mdiamond]\nend [shape=Msquare]\nstart -> mid -> end }`);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges[0].source).toBe('start');
    expect(graph.edges[0].target).toBe('mid');
    expect(graph.edges[1].source).toBe('mid');
    expect(graph.edges[1].target).toBe('end');
  });

  it('parses llm_model attribute', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nimpl [shape=box, prompt="Do", llm_model="claude-opus-4-20250514"]\nend [shape=Msquare]\nstart -> impl -> end }`);
    const impl = graph.nodeMap.get('impl');
    expect(impl?.llmModel).toBe('claude-opus-4-20250514');
  });

  it('parses model as alias for llm_model', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nimpl [shape=box, prompt="Do", model="claude-opus-4-6"]\nend [shape=Msquare]\nstart -> impl -> end }`);
    const impl = graph.nodeMap.get('impl');
    expect(impl?.llmModel).toBe('claude-opus-4-6');
  });

  it('prefers llm_model over model when both are set', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nimpl [shape=box, prompt="Do", llm_model="primary", model="fallback"]\nend [shape=Msquare]\nstart -> impl -> end }`);
    const impl = graph.nodeMap.get('impl');
    expect(impl?.llmModel).toBe('primary');
  });

  it('parses llm_provider attribute', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nimpl [shape=box, prompt="Do", llm_provider="openai"]\nend [shape=Msquare]\nstart -> impl -> end }`);
    const impl = graph.nodeMap.get('impl');
    expect(impl?.llmProvider).toBe('openai');
  });

  it('parses assert_exists as a comma-separated list', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nimpl [shape=parallelogram, tool_command="echo hi", assert_exists="docs/a.md, docs/b.md"]\nend [shape=Msquare]\nstart -> impl -> end }`);
    const impl = graph.nodeMap.get('impl');
    expect(impl?.assertExists).toEqual(['docs/a.md', 'docs/b.md']);
  });

  it('parses node retry_policy attribute', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nimpl [shape=box, prompt="Do", retry_policy="patient"]\nend [shape=Msquare]\nstart -> impl -> end }`);
    const impl = graph.nodeMap.get('impl');
    expect(impl?.retryPolicy).toBe('patient');
  });

  it('parses graph default_retry_policy attribute', () => {
    const graph = parseGardenSource(`digraph G { graph [default_retry_policy="standard"]\nstart [shape=Mdiamond]\nend [shape=Msquare]\nstart -> end }`);
    expect(graph.defaultRetryPolicy).toBe('standard');
  });

  it('preserves script fallback without rewriting explicit tool_command attribute', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nimpl [shape=parallelogram, script="echo legacy"]\nend [shape=Msquare]\nstart -> impl -> end }`);
    const impl = graph.nodeMap.get('impl');
    expect(impl?.toolCommand).toBe('echo legacy');
    expect(impl?.attributes.tool_command).toBeUndefined();
    expect(impl?.attributes.script).toBe('echo legacy');
  });

  it('parses reasoning_effort attribute', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nimpl [shape=box, prompt="Do", reasoning_effort="high"]\nend [shape=Msquare]\nstart -> impl -> end }`);
    const impl = graph.nodeMap.get('impl');
    expect(impl?.reasoningEffort).toBe('high');
  });

  it('parses class attribute as comma-separated list', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nimpl [shape=box, prompt="Do", class="drafts,review"]\nend [shape=Msquare]\nstart -> impl -> end }`);
    const impl = graph.nodeMap.get('impl');
    expect(impl?.classes).toEqual(['drafts', 'review']);
  });

  it('deduplicates class values', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nimpl [shape=box, prompt="Do", class="drafts,drafts"]\nend [shape=Msquare]\nstart -> impl -> end }`);
    const impl = graph.nodeMap.get('impl');
    expect(impl?.classes).toEqual(['drafts']);
  });

  it('parses model_stylesheet graph attribute', () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="box { llm_model: claude-sonnet-4-20250514 }"
      start [shape=Mdiamond]
      end [shape=Msquare]
      start -> end
    }`);
    expect(graph.modelStylesheet).toBe('box { llm_model: claude-sonnet-4-20250514 }');
  });

  it('node without new attributes has undefined fields', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nend [shape=Msquare]\nstart -> end }`);
    const start = graph.nodeMap.get('start');
    expect(start?.llmModel).toBeUndefined();
    expect(start?.llmProvider).toBeUndefined();
    expect(start?.reasoningEffort).toBeUndefined();
    expect(start?.classes).toEqual([]);
  });

  // --- Sprint 010: New Attributes ---

  it('parses auto_status attribute on nodes', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nllm [shape=box, prompt="go", auto_status="true"]\nend [shape=Msquare]\nstart -> llm -> end }`);
    expect(graph.nodeMap.get('llm')?.autoStatus).toBe(true);
  });

  it('parses fidelity attribute on nodes', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nllm [shape=box, prompt="go", fidelity="compact"]\nend [shape=Msquare]\nstart -> llm -> end }`);
    expect(graph.nodeMap.get('llm')?.fidelity).toBe('compact');
  });

  it('parses thread_id attribute on nodes', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nllm [shape=box, prompt="go", thread_id="t1"]\nend [shape=Msquare]\nstart -> llm -> end }`);
    expect(graph.nodeMap.get('llm')?.threadId).toBe('t1');
  });

  it('parses fidelity attribute on edges', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nend [shape=Msquare]\nstart -> end [fidelity="truncate"] }`);
    expect(graph.edges[0]?.fidelity).toBe('truncate');
  });

  it('parses thread_id attribute on edges', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nend [shape=Msquare]\nstart -> end [thread_id="t2"] }`);
    expect(graph.edges[0]?.threadId).toBe('t2');
  });

  it('parses default_fidelity graph attribute', () => {
    const graph = parseGardenSource(`digraph G { default_fidelity="summary:medium"\nstart [shape=Mdiamond]\nend [shape=Msquare]\nstart -> end }`);
    expect(graph.defaultFidelity).toBe('summary:medium');
  });

  it('normalizes class names from subgraphs', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      subgraph cluster_My_Group {
        label="My Group"
        impl [shape=box, prompt="go"]
      }
      end [shape=Msquare]
      start -> impl -> end
    }`);
    expect(graph.nodeMap.get('impl')?.classes).toContain('my-group');
  });

  it('normalizes class names with spaces/punctuation', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      impl [shape=box, prompt="go", class="My Class!"]
      end [shape=Msquare]
      start -> impl -> end
    }`);
    expect(graph.nodeMap.get('impl')?.classes).toContain('my-class');
  });

  it('parses quoted reserved-word node IDs ("node", "edge")', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      "node" [shape=box, prompt="I am called node"]
      end [shape=Msquare]
      start -> "node" -> end
    }`);
    expect(graph.nodeMap.has('node')).toBe(true);
    expect(graph.nodeMap.get('node')?.kind).toBe('codergen');
  });

  it('parses stylesheet-basic.dot fixture', async () => {
    const graph = await parseGardenFile(path.join(ROOT, 'test', 'fixtures', 'stylesheet-basic.dot'));
    expect(graph.modelStylesheet).toBeDefined();
    expect(graph.defaultFidelity).toBe('summary:medium');
    expect(graph.nodeMap.get('claude_draft')?.classes).toContain('drafts');
    expect(graph.nodeMap.get('deep_review')?.classes).toContain('reviewers');
  });

  // --- Sprint 017: Manager loop, loop_restart, tool hooks ---

  it('parses house shape as stack.manager_loop', () => {
    const graph = parseGardenSource(`digraph G {
      "stack.child_dotfile"="gardens/child.dot"
      start [shape=Mdiamond]
      supervisor [shape=house, prompt="Focus"]
      done [shape=Msquare]
      start -> supervisor -> done
    }`);
    const sup = graph.nodeMap.get('supervisor');
    expect(sup?.kind).toBe('stack.manager_loop');
    expect(sup?.shape).toBe('house');
  });

  it('parses manager.* attributes on house nodes', async () => {
    const graph = await parseGardenFile(path.join(ROOT, 'test', 'fixtures', 'manager-basic.dot'));
    const supervisor = graph.nodeMap.get('supervisor');
    expect(supervisor?.kind).toBe('stack.manager_loop');
    expect(supervisor?.managerPollIntervalMs).toBe(5000);
    expect(supervisor?.managerMaxCycles).toBe(50);
    expect(supervisor?.managerStopCondition).toBe('context.stack.child.status=completed');
    expect(supervisor?.managerActions).toEqual(['observe', 'steer', 'wait']);
    expect(supervisor?.prompt).toBe('Focus on tests.');
  });

  it('parses stack.child_dotfile and stack.child_workdir graph attributes', async () => {
    const graph = await parseGardenFile(path.join(ROOT, 'test', 'fixtures', 'manager-basic.dot'));
    expect(graph.childDotfile).toBe('gardens/child.dot');
    expect(graph.childWorkdir).toBe('workdir');
  });

  it('parses stack.child_autostart=false on nodes', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      sup [shape=house, "stack.child_autostart"="false"]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    expect(graph.nodeMap.get('sup')?.childAutostart).toBe(false);
  });

  it('parses loop_restart attribute on edges', async () => {
    const graph = await parseGardenFile(path.join(ROOT, 'test', 'fixtures', 'loop-restart.dot'));
    const restartEdge = graph.edges.find(e => e.source === 'review' && e.target === 'implement' && e.loopRestart);
    expect(restartEdge).toBeTruthy();
    expect(restartEdge?.loopRestart).toBe(true);
    // Normal edges default to false
    const normalEdge = graph.edges.find(e => e.source === 'start' && e.target === 'implement');
    expect(normalEdge?.loopRestart).toBe(false);
  });

  it('parses tool_hooks.pre and tool_hooks.post at graph level', () => {
    const graph = parseGardenSource(`digraph G {
      graph ["tool_hooks.pre"="./scripts/policy.sh", "tool_hooks.post"="./scripts/audit.sh"]
      start [shape=Mdiamond]
      done [shape=Msquare]
      start -> done
    }`);
    expect(graph.toolHooksPre).toBe('./scripts/policy.sh');
    expect(graph.toolHooksPost).toBe('./scripts/audit.sh');
  });

  it('parses tool_hooks.pre and tool_hooks.post at node level', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      impl [shape=box, prompt="Go", "tool_hooks.pre"="./pre.sh", "tool_hooks.post"="./post.sh"]
      done [shape=Msquare]
      start -> impl -> done
    }`);
    const impl = graph.nodeMap.get('impl');
    expect(impl?.toolHooksPre).toBe('./pre.sh');
    expect(impl?.toolHooksPost).toBe('./post.sh');
  });

  it('defaults manager.actions to undefined when not specified', () => {
    const graph = parseGardenSource(`digraph G {
      "stack.child_dotfile"="child.dot"
      start [shape=Mdiamond]
      sup [shape=house]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    expect(graph.nodeMap.get('sup')?.managerActions).toBeUndefined();
  });

  it('parses max_restart_depth graph attribute', () => {
    const graph = parseGardenSource(`digraph G {
      graph [max_restart_depth="10"]
      start [shape=Mdiamond]
      done [shape=Msquare]
      start -> done
    }`);
    expect(graph.maxRestartDepth).toBe(10);
  });

  it('maxRestartDepth is undefined when not set', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      done [shape=Msquare]
      start -> done
    }`);
    expect(graph.maxRestartDepth).toBeUndefined();
  });
});

describe('normalizeClassName', () => {
  it('lowercases', () => {
    expect(normalizeClassName('FooBar')).toBe('foobar');
  });

  it('replaces spaces with hyphens', () => {
    expect(normalizeClassName('my class')).toBe('my-class');
  });

  it('replaces punctuation with hyphens', () => {
    expect(normalizeClassName('hello!world')).toBe('hello-world');
  });

  it('collapses consecutive hyphens', () => {
    expect(normalizeClassName('a--b')).toBe('a-b');
  });

  it('strips leading/trailing hyphens', () => {
    expect(normalizeClassName('-foo-')).toBe('foo');
  });

  it('handles alphanumeric with hyphens', () => {
    expect(normalizeClassName('draft-v2')).toBe('draft-v2');
  });
});
