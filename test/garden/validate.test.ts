import { describe, expect, it } from 'vitest';
import { parseGardenSource } from '../../src/garden/parse.js';
import { validateGarden } from '../../src/garden/validate.js';

function codes(dot: string): string[] {
  const graph = parseGardenSource(dot);
  return validateGarden(graph).map((diagnostic) => diagnostic.code);
}

describe('garden validate', () => {
  it('rejects unsupported shapes', () => {
    const errors = codes(`digraph G { start [shape=Mdiamond]\nmid [shape=box]\nend [shape=Msquare]\nstart -> mid\nmid -> end }`);
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
});
