import { describe, expect, it } from 'vitest';
import { ToolHandler } from '../../src/handlers/tool.js';
import { GardenNode } from '../../src/garden/types.js';

function toolNode(overrides: Partial<GardenNode> = {}): GardenNode {
  return {
    id: overrides.id ?? 'tool',
    kind: 'tool',
    attributes: overrides.attributes ?? { script: 'node -e "process.exit(0)"' },
    label: overrides.label,
    shape: overrides.shape ?? 'parallelogram',
    type: overrides.type,
    maxRetries: overrides.maxRetries,
    timeoutMs: overrides.timeoutMs,
    location: overrides.location
  };
}

describe('ToolHandler', () => {
  it('executes successful scripts', async () => {
    const handler = new ToolHandler();
    const outcome = await handler.execute({
      node: toolNode({
        attributes: { script: 'node -e "console.log(process.env.NECTAR_RUN_ID)"' }
      }),
      run_id: 'run-123',
      dot_file: 'garden.dot',
      attempt: 1,
      run_dir: '/tmp/nectar-test',
      context: {}
    });

    expect(outcome.status).toBe('success');
    expect(outcome.stdout).toContain('run-123');
  });

  it('returns failure for non-zero exit codes', async () => {
    const handler = new ToolHandler();
    const outcome = await handler.execute({
      node: toolNode({ attributes: { script: 'node -e "process.exit(7)"' } }),
      run_id: 'run-123',
      dot_file: 'garden.dot',
      attempt: 1,
      run_dir: '/tmp/nectar-test',
      context: {}
    });

    expect(outcome.status).toBe('failure');
    expect(outcome.exit_code).toBe(7);
  });

  it('enforces timeout', async () => {
    const handler = new ToolHandler();
    const outcome = await handler.execute({
      node: toolNode({
        timeoutMs: 25,
        attributes: { script: 'node -e "setTimeout(() => {}, 1000)"' }
      }),
      run_id: 'run-123',
      dot_file: 'garden.dot',
      attempt: 1,
      run_dir: '/tmp/nectar-test',
      context: {}
    });

    expect(outcome.status).toBe('failure');
    expect(outcome.timed_out).toBe(true);
  });
});
