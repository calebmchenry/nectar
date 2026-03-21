import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/agent-loop/tool-registry.js';
import type { ExecutionEnvironment } from '../../src/agent-loop/execution-environment.js';
import { TOOL_OUTPUT_LIMITS } from '../../src/agent-loop/types.js';

// Minimal stub environment for registry tests
const stubEnv: ExecutionEnvironment = {
  workspaceRoot: '/tmp/test',
  readFile: async () => 'file content',
  writeFile: async () => {},
  fileExists: async () => true,
  resolvePath: async (p) => `/tmp/test/${p}`,
  exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  glob: async () => [],
  grep: async () => [],
};

describe('ToolRegistry', () => {
  it('registers a tool and returns definitions', () => {
    const registry = new ToolRegistry();
    registry.register('test_tool', 'A test tool', {
      properties: { name: { type: 'string' } },
      required: ['name'],
    }, async (args) => `Hello ${args.name}`);

    const defs = registry.definitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('test_tool');
    expect(defs[0]!.description).toBe('A test tool');
  });

  it('executes a tool successfully', async () => {
    const registry = new ToolRegistry();
    registry.register('greet', 'Greet', {
      properties: { name: { type: 'string' } },
      required: ['name'],
    }, async (args) => `Hello ${args.name}`);

    const result = await registry.execute({
      name: 'greet',
      arguments: { name: 'World' },
      call_id: 'call-1',
    }, stubEnv);

    expect(result.is_error).toBe(false);
    expect(result.content).toBe('Hello World');
    expect(result.call_id).toBe('call-1');
  });

  it('returns error for unknown tool', async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute({
      name: 'nonexistent',
      arguments: {},
      call_id: 'call-2',
    }, stubEnv);

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Unknown tool');
  });

  it('validates arguments against schema', async () => {
    const registry = new ToolRegistry();
    registry.register('strict', 'Strict tool', {
      properties: { count: { type: 'integer' } },
      required: ['count'],
    }, async (args) => `Count: ${args.count}`);

    const result = await registry.execute({
      name: 'strict',
      arguments: { count: 'not a number' },
      call_id: 'call-3',
    }, stubEnv);

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Invalid arguments');
  });

  it('catches handler errors and returns structured error', async () => {
    const registry = new ToolRegistry();
    registry.register('boom', 'Boom tool', {
      properties: {},
    }, async () => { throw new Error('kaboom'); });

    const result = await registry.execute({
      name: 'boom',
      arguments: {},
      call_id: 'call-4',
    }, stubEnv);

    expect(result.is_error).toBe(true);
    expect(result.content).toBe('kaboom');
  });

  it('truncates large tool output', async () => {
    const registry = new ToolRegistry();
    registry.register('big', 'Big output', {
      properties: {},
    }, async () => 'x'.repeat(100_000));

    const result = await registry.execute({
      name: 'big',
      arguments: {},
      call_id: 'call-5',
    }, stubEnv);

    expect(result.is_error).toBe(false);
    expect(result.content.length).toBeLessThan(100_000);
    expect(result.content).toContain('truncated');
    expect(result.full_content).toBe('x'.repeat(100_000));
  });

  it('applies output and line limit overrides when provided', async () => {
    const registry = new ToolRegistry();
    registry.register('custom', 'Custom output', {
      properties: {},
    }, async () => Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n'));

    const result = await registry.execute({
      name: 'custom',
      arguments: {},
      call_id: 'call-6',
    }, stubEnv, {
      output_limits: { custom: 200 },
      line_limits: { custom: 5 },
    });

    expect(result.is_error).toBe(false);
    expect(result.content).toContain('lines omitted');
    expect(result.content).toContain('line-0');
    expect(result.content).toContain('line-19');
    const lines = result.content.split('\n');
    expect(lines.length).toBeLessThanOrEqual(7); // kept lines + truncation marker
  });

  it('has() checks tool existence', () => {
    const registry = new ToolRegistry();
    expect(registry.has('foo')).toBe(false);
    registry.register('foo', 'Foo', { properties: {} }, async () => 'ok');
    expect(registry.has('foo')).toBe(true);
  });

  it('defines an explicit default output limit for spawn_agent', () => {
    expect(TOOL_OUTPUT_LIMITS.spawn_agent).toBe(20_000);
  });
});
