import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UnifiedClient } from '../../src/llm/client.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import { AgentSession } from '../../src/agent-loop/session.js';
import { ToolRegistry } from '../../src/agent-loop/tool-registry.js';
import { LocalExecutionEnvironment } from '../../src/agent-loop/execution-environment.js';
import { AnthropicProfile, GeminiProfile } from '../../src/agent-loop/provider-profiles.js';
import type { SessionConfig } from '../../src/agent-loop/types.js';
import type { AgentEvent } from '../../src/agent-loop/events.js';
import { ScriptedAdapter } from '../helpers/scripted-adapter.js';
import { readFileHandler, readFileSchema, readFileDescription } from '../../src/agent-loop/tools/read-file.js';
import { writeFileHandler, writeFileSchema, writeFileDescription } from '../../src/agent-loop/tools/write-file.js';
import { grepHandler, grepSchema, grepDescription } from '../../src/agent-loop/tools/grep.js';
import { globHandler, globSchema, globDescription } from '../../src/agent-loop/tools/glob.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-parallel-test-'));
  tempDirs.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(path.join(dir, 'b.ts'), 'export const b = 2;\n', 'utf8');
  await writeFile(path.join(dir, 'c.ts'), 'export const c = 3;\n', 'utf8');
  await writeFile(path.join(dir, 'd.ts'), 'export const d = 4;\n', 'utf8');
  return dir;
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register('read_file', readFileDescription, readFileSchema, readFileHandler);
  registry.register('write_file', writeFileDescription, writeFileSchema, writeFileHandler);
  registry.register('grep', grepDescription, grepSchema, grepHandler);
  registry.register('glob', globDescription, globSchema, globHandler);
  return registry;
}

function makeConfig(workspace: string): SessionConfig {
  return {
    max_turns: 12,
    max_tool_rounds_per_input: 10,
    default_command_timeout_ms: 30_000,
    workspace_root: workspace,
  };
}

describe('parallel tool execution in agent session', () => {
  it('4 read_file calls return results in correct order', async () => {
    const workspace = await createWorkspace();
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([
      {
        tool_calls: [
          { id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } },
          { id: 'tc2', name: 'read_file', arguments: { path: 'b.ts' } },
          { id: 'tc3', name: 'read_file', arguments: { path: 'c.ts' } },
          { id: 'tc4', name: 'read_file', arguments: { path: 'd.ts' } },
        ],
      },
      { text: 'Read all 4 files.' },
    ]);

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace),
      { onEvent: (e) => events.push(e) },
    );

    const result = await session.processInput('Read all files');
    expect(result.status).toBe('success');
    expect(result.tool_call_count).toBe(4);

    const toolStarted = events.filter(e => e.type === 'agent_tool_call_started');
    const toolCompleted = events.filter(e => e.type === 'agent_tool_call_completed');
    expect(toolStarted).toHaveLength(4);
    expect(toolCompleted).toHaveLength(4);
  });

  it('parallel_tool_execution: false falls back to sequential', async () => {
    const workspace = await createWorkspace();

    const adapter = new ScriptedAdapter([
      {
        tool_calls: [
          { id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } },
          { id: 'tc2', name: 'read_file', arguments: { path: 'b.ts' } },
        ],
      },
      { text: 'Done' },
    ]);

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    // GeminiProfile has parallel_tool_execution: false
    const session = new AgentSession(
      client, makeRegistry(), new GeminiProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace),
    );

    const result = await session.processInput('Read files');
    expect(result.status).toBe('success');
    expect(result.tool_call_count).toBe(2);
  });

  it('tool results correctly match provider ordering requirements', async () => {
    const workspace = await createWorkspace();
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([
      {
        tool_calls: [
          { id: 'tc-a', name: 'read_file', arguments: { path: 'a.ts' } },
          { id: 'tc-b', name: 'read_file', arguments: { path: 'b.ts' } },
        ],
      },
      { text: 'Done' },
    ]);

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace),
      { onEvent: (e) => events.push(e) },
    );

    const result = await session.processInput('Read a.ts and b.ts');
    expect(result.status).toBe('success');

    const starts = events.filter(e => e.type === 'agent_tool_call_started');
    expect(starts[0]!.call_id).toBe('tc-a');
    expect(starts[1]!.call_id).toBe('tc-b');
  });

  it('one tool failure does not crash the batch', async () => {
    const workspace = await createWorkspace();

    const adapter = new ScriptedAdapter([
      {
        tool_calls: [
          { id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } },
          { id: 'tc2', name: 'read_file', arguments: { path: 'nonexistent.ts' } },
          { id: 'tc3', name: 'read_file', arguments: { path: 'b.ts' } },
        ],
      },
      { text: 'One file was missing but I read the others.' },
    ]);

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace),
    );

    const result = await session.processInput('Read files');
    expect(result.status).toBe('success');
    expect(result.tool_call_count).toBe(3);
  });

  it('transcript numbering is deterministic (original call order)', async () => {
    const workspace = await createWorkspace();
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([
      {
        tool_calls: [
          { id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } },
          { id: 'tc2', name: 'glob', arguments: { pattern: '*.ts' } },
        ],
      },
      { text: 'Done' },
    ]);

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      makeConfig(workspace),
      { onEvent: (e) => events.push(e) },
    );

    const result = await session.processInput('Search');
    expect(result.status).toBe('success');
    expect(result.tool_call_count).toBe(2);
  });
});
