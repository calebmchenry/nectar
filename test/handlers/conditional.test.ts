import { describe, expect, it } from 'vitest';
import { ConditionalHandler } from '../../src/handlers/conditional.js';
import { GardenNode } from '../../src/garden/types.js';

function conditionalNode(overrides: Partial<GardenNode> = {}): GardenNode {
  return {
    id: overrides.id ?? 'branch',
    kind: 'conditional',
    shape: 'diamond',
    attributes: overrides.attributes ?? {},
    label: overrides.label,
    prompt: overrides.prompt,
  };
}

describe('ConditionalHandler', () => {
  it('returns success as a pass-through without prompt', async () => {
    const handler = new ConditionalHandler();
    const outcome = await handler.execute({
      node: conditionalNode(),
      run_id: 'test-run',
      dot_file: 'test.dot',
      attempt: 1,
      run_dir: '/tmp/test',
      context: {}
    });

    expect(outcome.status).toBe('success');
  });

  it('fails fast when prompt is present', async () => {
    const handler = new ConditionalHandler();
    const outcome = await handler.execute({
      node: conditionalNode({
        prompt: 'Should we proceed?',
        attributes: { prompt: 'Should we proceed?' },
      }),
      run_id: 'test-run',
      dot_file: 'test.dot',
      attempt: 1,
      run_dir: '/tmp/test',
      context: {},
    });

    expect(outcome.status).toBe('failure');
    expect(outcome.error_message).toContain('Conditional nodes do not support prompt evaluation');
  });

  it('does not produce context updates', async () => {
    const handler = new ConditionalHandler();
    const outcome = await handler.execute({
      node: conditionalNode({ id: 'decision' }),
      run_id: 'test-run',
      dot_file: 'test.dot',
      attempt: 1,
      run_dir: '/tmp/test',
      context: { some_key: 'some_value' }
    });

    expect(outcome.status).toBe('success');
    expect(outcome.context_updates).toBeUndefined();
  });
});
