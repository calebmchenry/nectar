import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolHandler } from '../../src/handlers/tool.js';
import { GardenNode } from '../../src/garden/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nectar-tool-handler-'));
  tempDirs.push(workspace);
  return workspace;
}

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
    assertExists: overrides.assertExists,
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
    expect(outcome.context_updates?.['tool.output']).toContain('run-123');
    expect(outcome.context_updates?.['tool.exit_code']).toBe('0');
    expect(outcome.context_updates?.['tool.stderr']).toBeUndefined();
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

  it('prefers tool_command over script when both are present', async () => {
    const handler = new ToolHandler();
    const outcome = await handler.execute({
      node: toolNode({
        attributes: {
          tool_command: 'node -e "console.log(\'tool-command\')"',
          script: 'node -e "console.log(\'legacy-script\')"',
        },
      }),
      run_id: 'run-123',
      dot_file: 'garden.dot',
      attempt: 1,
      run_dir: '/tmp/nectar-test',
      context: {},
    });

    expect(outcome.status).toBe('success');
    expect(outcome.stdout).toContain('tool-command');
    expect(outcome.stdout).not.toContain('legacy-script');
  });

  it('fails when assert_exists artifact is missing after exit 0', async () => {
    const workspace = await createWorkspace();
    const handler = new ToolHandler();
    const outcome = await handler.execute({
      node: toolNode({
        attributes: { tool_command: 'node -e "process.exit(0)"' },
        assertExists: ['docs/out.txt'],
      }),
      run_id: 'run-assert-missing',
      dot_file: 'garden.dot',
      attempt: 1,
      run_dir: '/tmp/nectar-test',
      context: {},
      workspace_root: workspace,
    });

    expect(outcome.status).toBe('failure');
    expect(outcome.error_message).toContain(`expected file 'docs/out.txt' does not exist`);
  });

  it('keeps success when assert_exists artifact is present', async () => {
    const workspace = await createWorkspace();
    const handler = new ToolHandler();
    const outcome = await handler.execute({
      node: toolNode({
        attributes: { tool_command: 'node -e "require(\'node:fs\').mkdirSync(\'docs\', { recursive: true }); require(\'node:fs\').writeFileSync(\'docs/out.txt\', \'ok\')"' },
        assertExists: ['docs/out.txt'],
      }),
      run_id: 'run-assert-present',
      dot_file: 'garden.dot',
      attempt: 1,
      run_dir: '/tmp/nectar-test',
      context: {},
      workspace_root: workspace,
    });

    expect(outcome.status).toBe('success');
  });
});
