import { describe, expect, it } from 'vitest';
import { parseGardenSource } from '../../src/garden/parse.js';
import { validateGarden } from '../../src/garden/validate.js';

function codes(dot: string): string[] {
  const graph = parseGardenSource(dot);
  return validateGarden(graph).map((diagnostic) => diagnostic.code);
}

describe('garden validate', () => {
  it('rejects unsupported shapes', () => {
    const errors = codes(`digraph G { start [shape=Mdiamond]\nmid [shape=octagon]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
    expect(errors).toContain('UNSUPPORTED_SHAPE');
  });

  it('requires tool script', () => {
    const errors = codes(`digraph G { start [shape=Mdiamond]\nmid [shape=parallelogram]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
    expect(errors).toContain('TOOL_SCRIPT_REQUIRED');
  });

  it('requires valid max_retries', () => {
    const errors = codes(`digraph G { start [shape=Mdiamond]\nmid [shape=parallelogram, script="echo hi", max_retries=nope]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
    expect(errors).toContain('INVALID_MAX_RETRIES');
  });

  it('validates edge condition syntax', () => {
    const errors = codes(`digraph G { start [shape=Mdiamond]\nmid [shape=parallelogram, script="echo hi"]\nend [shape=Msquare]\nstart -> mid\nmid -> end [condition="(outcome=success)"] }`);
    expect(errors).toContain('INVALID_CONDITION');
  });

  it('finds unreachable nodes', () => {
    const errors = codes(`digraph G { start [shape=Mdiamond]\nmid [shape=parallelogram, script="echo hi"]\nend [shape=Msquare]\norphan [shape=parallelogram, script="echo orphan"]\nstart -> mid\nmid -> end }`);
    expect(errors).toContain('UNREACHABLE_NODE');
  });

  it('detects cycle with no exit path', () => {
    const errors = codes(`digraph G { start [shape=Mdiamond]\na [shape=parallelogram, script="echo a"]\nb [shape=parallelogram, script="echo b"]\nend [shape=Msquare]\nstart -> a\na -> b\nb -> a }`);
    expect(errors).toContain('CYCLE_WITHOUT_EXIT');
  });

  it('errors when start node has incoming edges', () => {
    const errors = codes(`digraph G { start [shape=Mdiamond]\nmid [shape=parallelogram, script="echo hi"]\nend [shape=Msquare]\nstart -> mid\nmid -> end\nmid -> start }`);
    expect(errors).toContain('START_NO_INCOMING');
  });

  it('errors when exit node has outgoing edges', () => {
    const errors = codes(`digraph G { start [shape=Mdiamond]\nend [shape=Msquare]\nstart -> end\nend -> start }`);
    expect(errors).toContain('EXIT_NO_OUTGOING');
  });

  it('warns on unknown node type', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nmid [shape=octagon]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
    const diags = validateGarden(graph);
    expect(diags.some((d) => d.code === 'TYPE_UNKNOWN')).toBe(true);
  });

  it('warns on invalid fidelity', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nmid [shape=parallelogram, script="echo hi", fidelity="2.0"]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
    const diags = validateGarden(graph);
    expect(diags.some((d) => d.code === 'FIDELITY_INVALID')).toBe(true);
  });

  it('accepts valid fidelity string enums', () => {
    for (const value of ['full', 'truncate', 'compact', 'summary:low', 'summary:medium', 'summary:high']) {
      const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nmid [shape=parallelogram, script="echo hi", fidelity="${value}"]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
      const diags = validateGarden(graph);
      expect(diags.some((d) => d.code === 'FIDELITY_INVALID')).toBe(false);
    }
  });

  it('rejects invalid fidelity string values', () => {
    for (const value of ['0.5', 'high', 'none', 'summary:invalid']) {
      const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nmid [shape=parallelogram, script="echo hi", fidelity="${value}"]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
      const diags = validateGarden(graph);
      expect(diags.some((d) => d.code === 'FIDELITY_INVALID')).toBe(true);
    }
  });

  it('warns when retry_target references non-existent node', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nmid [shape=parallelogram, script="echo hi", retry_target="nowhere"]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
    const diags = validateGarden(graph);
    expect(diags.some((d) => d.code === 'RETRY_TARGET_MISSING')).toBe(true);
  });

  it('warns when goal_gate node has no retry_target', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nmid [shape=parallelogram, script="echo hi", goal_gate="true"]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
    const diags = validateGarden(graph);
    expect(diags.some((d) => d.code === 'GOAL_GATE_NO_RETRY')).toBe(true);
  });

  it('warns when box node has no prompt', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nmid [shape=box]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
    const diags = validateGarden(graph);
    expect(diags.some((d) => d.code === 'PROMPT_MISSING')).toBe(true);
  });

  it('accepts box and diamond shapes', () => {
    const errors = codes(`digraph G { start [shape=Mdiamond]\nllm [shape=box, prompt="Do something"]\nbranch [shape=diamond]\nend [shape=Msquare]\nstart -> llm\nllm -> branch\nbranch -> end }`);
    expect(errors).not.toContain('UNSUPPORTED_SHAPE');
  });

  it('accepts hexagon shape for human gates', () => {
    const errors = codes(`digraph G { start [shape=Mdiamond]\ngate [shape=hexagon, label="Choose"]\nend [shape=Msquare]\nstart -> gate\ngate -> end [label="Go"] }`);
    expect(errors).not.toContain('UNSUPPORTED_SHAPE');
  });

  it('errors on invalid reasoning_effort', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nmid [shape=box, prompt="Do", reasoning_effort="extreme"]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
    const diags = validateGarden(graph);
    expect(diags.some((d) => d.code === 'INVALID_REASONING_EFFORT')).toBe(true);
  });

  it('accepts valid reasoning_effort values', () => {
    for (const value of ['low', 'medium', 'high']) {
      const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nmid [shape=box, prompt="Do", reasoning_effort="${value}"]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
      const diags = validateGarden(graph);
      expect(diags.some((d) => d.code === 'INVALID_REASONING_EFFORT')).toBe(false);
    }
  });

  it('warns on unknown llm_provider', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nmid [shape=box, prompt="Do", llm_provider="unknown_provider"]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
    const diags = validateGarden(graph);
    expect(diags.some((d) => d.code === 'UNKNOWN_LLM_PROVIDER')).toBe(true);
  });

  it('accepts known llm_provider values', () => {
    for (const value of ['anthropic', 'openai', 'gemini', 'simulation']) {
      const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nmid [shape=box, prompt="Do", llm_provider="${value}"]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
      const diags = validateGarden(graph);
      expect(diags.some((d) => d.code === 'UNKNOWN_LLM_PROVIDER')).toBe(false);
    }
  });

  it('detects stylesheet syntax errors via validation', () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="box { llm_model }"
      start [shape=Mdiamond]
      end [shape=Msquare]
      start -> end
    }`);
    const diags = validateGarden(graph);
    expect(diags.some((d) => d.code === 'STYLESHEET_SYNTAX')).toBe(true);
  });

  it('no stylesheet_syntax error for valid stylesheet', () => {
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="box { llm_model: claude-sonnet-4-20250514 }"
      start [shape=Mdiamond]
      end [shape=Msquare]
      start -> end
    }`);
    const diags = validateGarden(graph);
    expect(diags.some((d) => d.code === 'STYLESHEET_SYNTAX')).toBe(false);
  });

  it('no stylesheet errors when model_stylesheet is absent', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nend [shape=Msquare]\nstart -> end }`);
    const diags = validateGarden(graph);
    expect(diags.some((d) => d.code === 'STYLESHEET_SYNTAX')).toBe(false);
  });

  it('validates node fidelity values', () => {
    const graph = parseGardenSource(`digraph G { start [shape=Mdiamond]\nmid [shape=parallelogram, script="echo hi", fidelity="bogus"]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
    const diags = validateGarden(graph);
    expect(diags.some((d) => d.code === 'FIDELITY_INVALID')).toBe(true);
  });

  // --- Sprint 017: Manager loop, loop_restart, tool hooks validation ---

  it('accepts house shape for manager nodes', () => {
    const errors = codes(`digraph G {
      "stack.child_dotfile"="child.dot"
      start [shape=Mdiamond]
      sup [shape=house]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    expect(errors).not.toContain('UNSUPPORTED_SHAPE');
  });

  it('rejects invalid manager.actions', () => {
    const errors = codes(`digraph G {
      "stack.child_dotfile"="child.dot"
      start [shape=Mdiamond]
      sup [shape=house, "manager.actions"="observe,destroy"]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    expect(errors).toContain('INVALID_MANAGER_ACTIONS');
  });

  it('accepts valid manager.actions', () => {
    const errors = codes(`digraph G {
      "stack.child_dotfile"="child.dot"
      start [shape=Mdiamond]
      sup [shape=house, "manager.actions"="observe,steer,wait"]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    expect(errors).not.toContain('INVALID_MANAGER_ACTIONS');
  });

  it('rejects invalid manager.max_cycles', () => {
    const errors = codes(`digraph G {
      "stack.child_dotfile"="child.dot"
      start [shape=Mdiamond]
      sup [shape=house, "manager.max_cycles"="abc"]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    expect(errors).toContain('INVALID_MANAGER_MAX_CYCLES');
  });

  it('rejects invalid manager.poll_interval', () => {
    const errors = codes(`digraph G {
      "stack.child_dotfile"="child.dot"
      start [shape=Mdiamond]
      sup [shape=house, "manager.poll_interval"="nope"]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    expect(errors).toContain('INVALID_MANAGER_POLL_INTERVAL');
  });

  it('rejects invalid manager.stop_condition', () => {
    const errors = codes(`digraph G {
      "stack.child_dotfile"="child.dot"
      start [shape=Mdiamond]
      sup [shape=house, "manager.stop_condition"="(broken)"]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    expect(errors).toContain('INVALID_MANAGER_STOP_CONDITION');
  });

  it('warns when steer action has no prompt', () => {
    const graph = parseGardenSource(`digraph G {
      "stack.child_dotfile"="child.dot"
      start [shape=Mdiamond]
      sup [shape=house, "manager.actions"="observe,steer"]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    const diags = validateGarden(graph);
    expect(diags.some(d => d.code === 'MANAGER_STEER_NO_PROMPT')).toBe(true);
  });

  it('errors when manager autostart has no child_dotfile', () => {
    const errors = codes(`digraph G {
      start [shape=Mdiamond]
      sup [shape=house]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    expect(errors).toContain('MANAGER_MISSING_CHILD_DOTFILE');
  });

  it('no error when manager autostart=false without child_dotfile', () => {
    const errors = codes(`digraph G {
      start [shape=Mdiamond]
      sup [shape=house, "stack.child_autostart"="false"]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    expect(errors).not.toContain('MANAGER_MISSING_CHILD_DOTFILE');
  });

  it('warns on tool_hooks on non-codergen nodes', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      mid [shape=parallelogram, script="echo hi", "tool_hooks.pre"="./hook.sh"]
      done [shape=Msquare]
      start -> mid -> done
    }`);
    const diags = validateGarden(graph);
    expect(diags.some(d => d.code === 'TOOL_HOOKS_NON_CODERGEN')).toBe(true);
  });

  it('warns on loop_restart from exit node', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      done [shape=Msquare]
      start -> done
      done -> start [loop_restart="true"]
    }`);
    const diags = validateGarden(graph);
    expect(diags.some(d => d.code === 'LOOP_RESTART_FROM_EXIT')).toBe(true);
  });

  it('errors when steer action has no prompt (severity=error)', () => {
    const graph = parseGardenSource(`digraph G {
      "stack.child_dotfile"="child.dot"
      start [shape=Mdiamond]
      sup [shape=house, "manager.actions"="observe,steer"]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    const diags = validateGarden(graph);
    const steerDiag = diags.find(d => d.code === 'MANAGER_STEER_NO_PROMPT');
    expect(steerDiag).toBeTruthy();
    expect(steerDiag?.severity).toBe('error');
  });

  it('rejects manager.poll_interval below minimum 1s', () => {
    const errors = codes(`digraph G {
      "stack.child_dotfile"="child.dot"
      start [shape=Mdiamond]
      sup [shape=house, "manager.poll_interval"="500ms"]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    expect(errors).toContain('INVALID_MANAGER_POLL_INTERVAL');
  });

  it('accepts manager.poll_interval at 1s', () => {
    const errors = codes(`digraph G {
      "stack.child_dotfile"="child.dot"
      start [shape=Mdiamond]
      sup [shape=house, "manager.poll_interval"="1s"]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    // Should not have the min 1s error (may still have others)
    const graph = parseGardenSource(`digraph G {
      "stack.child_dotfile"="child.dot"
      start [shape=Mdiamond]
      sup [shape=house, "manager.poll_interval"="1s"]
      done [shape=Msquare]
      start -> sup -> done
    }`);
    const diags = validateGarden(graph);
    const pollDiag = diags.find(d => d.code === 'INVALID_MANAGER_POLL_INTERVAL');
    expect(pollDiag).toBeUndefined();
  });

  it('warns on unconditional loop_restart edge', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      a [shape=parallelogram, script="echo a"]
      b [shape=parallelogram, script="echo b"]
      done [shape=Msquare]
      start -> a
      a -> b
      b -> a [loop_restart="true"]
      b -> done [condition="outcome=success"]
    }`);
    const diags = validateGarden(graph);
    expect(diags.some(d => d.code === 'LOOP_RESTART_UNCONDITIONAL')).toBe(true);
  });

  it('no unconditional warning when loop_restart has condition', () => {
    const graph = parseGardenSource(`digraph G {
      start [shape=Mdiamond]
      a [shape=parallelogram, script="echo a"]
      b [shape=parallelogram, script="echo b"]
      done [shape=Msquare]
      start -> a
      a -> b
      b -> a [loop_restart="true", condition="outcome=failure"]
      b -> done [condition="outcome=success"]
    }`);
    const diags = validateGarden(graph);
    expect(diags.some(d => d.code === 'LOOP_RESTART_UNCONDITIONAL')).toBe(false);
  });
});
