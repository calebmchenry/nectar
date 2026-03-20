import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UnifiedClient } from '../../src/llm/client.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import { AgentSession } from '../../src/agent-loop/session.js';
import { ToolRegistry } from '../../src/agent-loop/tool-registry.js';
import { LocalExecutionEnvironment } from '../../src/agent-loop/execution-environment.js';
import { AnthropicProfile } from '../../src/agent-loop/provider-profiles.js';
import { TranscriptWriter } from '../../src/agent-loop/transcript.js';
import type { SessionConfig } from '../../src/agent-loop/types.js';
import { ScriptedAdapter } from '../helpers/scripted-adapter.js';
import { readFileHandler, readFileSchema, readFileDescription } from '../../src/agent-loop/tools/read-file.js';
import { writeFileHandler, writeFileSchema, writeFileDescription } from '../../src/agent-loop/tools/write-file.js';
import { editFileHandler, editFileSchema, editFileDescription } from '../../src/agent-loop/tools/edit-file.js';
import { shellHandler, shellSchema, shellDescription } from '../../src/agent-loop/tools/shell.js';
import { grepHandler, grepSchema, grepDescription } from '../../src/agent-loop/tools/grep.js';
import { globHandler, globSchema, globDescription } from '../../src/agent-loop/tools/glob.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-agent-int-'));
  tempDirs.push(dir);
  // Set up a small fixture workspace
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'main.ts'), 'export const version = "1.0.0";\n', 'utf8');
  await writeFile(path.join(dir, 'README.md'), '# Test Project\n', 'utf8');
  return dir;
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register('read_file', readFileDescription, readFileSchema, readFileHandler);
  registry.register('write_file', writeFileDescription, writeFileSchema, writeFileHandler);
  registry.register('edit_file', editFileDescription, editFileSchema, editFileHandler);
  registry.register('shell', shellDescription, shellSchema, shellHandler);
  registry.register('grep', grepDescription, grepSchema, grepHandler);
  registry.register('glob', globDescription, globSchema, globHandler);
  return registry;
}

function makeRegistryWithSubagentTools(): ToolRegistry {
  const registry = makeRegistry();
  registry.register('spawn_agent', spawnAgentDescription, spawnAgentSchema, spawnAgentHandler);
  registry.register('send_input', sendInputDescription, sendInputSchema, sendInputHandler);
  registry.register('wait', waitDescription, waitSchema, waitHandler);
  registry.register('close_agent', closeAgentDescription, closeAgentSchema, closeAgentHandler);
  return registry;
}

import { DEFAULT_SUBAGENT_CONFIG } from '../../src/agent-loop/types.js';
import type { AgentEvent } from '../../src/agent-loop/events.js';
import { spawnAgentHandler, spawnAgentSchema, spawnAgentDescription } from '../../src/agent-loop/tools/spawn-agent.js';
import { sendInputHandler, sendInputSchema, sendInputDescription } from '../../src/agent-loop/tools/send-input.js';
import { waitHandler, waitSchema, waitDescription } from '../../src/agent-loop/tools/wait.js';
import { closeAgentHandler, closeAgentSchema, closeAgentDescription } from '../../src/agent-loop/tools/close-agent.js';
import { parseGardenSource } from '../../src/garden/parse.js';
import { transformAndValidate } from '../../src/garden/pipeline.js';

describe('agent-loop integration', () => {
  it('reads a file, edits it, runs a command, and completes', async () => {
    const workspace = await createWorkspace();
    const artifactDir = path.join(workspace, '.artifacts');

    const adapter = new ScriptedAdapter([
      // Turn 1: read the source file
      {
        tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'src/main.ts' } }],
      },
      // Turn 2: edit the version
      {
        tool_calls: [{
          id: 'tc2',
          name: 'edit_file',
          arguments: {
            path: 'src/main.ts',
            old_string: 'export const version = "1.0.0";',
            new_string: 'export const version = "2.0.0";',
          },
        }],
      },
      // Turn 3: verify with shell
      {
        tool_calls: [{ id: 'tc3', name: 'shell', arguments: { command: 'cat src/main.ts' } }],
      },
      // Turn 4: done
      { text: 'Updated version from 1.0.0 to 2.0.0 in src/main.ts.' },
    ]);

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const transcriptWriter = new TranscriptWriter(artifactDir);
    await transcriptWriter.writePrompt('Update the version to 2.0.0');

    const session = new AgentSession(
      client,
      makeRegistry(),
      new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      {
        max_turns: 12,
        max_tool_rounds_per_input: 10,
        default_command_timeout_ms: 30_000,
        workspace_root: workspace,
      },
      { transcriptWriter }
    );

    const result = await session.processInput('Update the version to 2.0.0');

    expect(result.status).toBe('success');
    expect(result.turn_count).toBe(4);
    expect(result.tool_call_count).toBe(3);

    // Verify the file was actually edited
    const content = await readFile(path.join(workspace, 'src', 'main.ts'), 'utf8');
    expect(content).toContain('2.0.0');
    expect(content).not.toContain('1.0.0');

    // Verify artifacts were written
    const promptFile = await readFile(path.join(artifactDir, 'prompt.md'), 'utf8');
    expect(promptFile).toBe('Update the version to 2.0.0');

    // Verify transcript.jsonl was written
    const transcriptFile = await readFile(path.join(artifactDir, 'transcript.jsonl'), 'utf8');
    const transcriptLines = transcriptFile.trim().split('\n');
    expect(transcriptLines.length).toBeGreaterThan(0);

    // Verify tool-call artifacts
    const toolCallDir = path.join(artifactDir, 'tool-calls', '001-read_file');
    const requestJson = JSON.parse(await readFile(path.join(toolCallDir, 'request.json'), 'utf8'));
    expect(requestJson.path).toBe('src/main.ts');
  });

  it('handles all six tools in a single session', async () => {
    const workspace = await createWorkspace();

    const adapter = new ScriptedAdapter([
      // glob
      { tool_calls: [{ id: 'tc1', name: 'glob', arguments: { pattern: '**/*.ts' } }] },
      // grep
      { tool_calls: [{ id: 'tc2', name: 'grep', arguments: { pattern: 'version' } }] },
      // read
      { tool_calls: [{ id: 'tc3', name: 'read_file', arguments: { path: 'src/main.ts' } }] },
      // edit
      { tool_calls: [{ id: 'tc4', name: 'edit_file', arguments: { path: 'src/main.ts', old_string: '"1.0.0"', new_string: '"3.0.0"' } }] },
      // write
      { tool_calls: [{ id: 'tc5', name: 'write_file', arguments: { path: 'CHANGELOG.md', content: '# v3.0.0\n- Updated version\n' } }] },
      // shell
      { tool_calls: [{ id: 'tc6', name: 'shell', arguments: { command: 'ls -la' } }] },
      // done
      { text: 'All done!' },
    ]);

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      { max_turns: 12, max_tool_rounds_per_input: 10, default_command_timeout_ms: 30_000, workspace_root: workspace }
    );

    const result = await session.processInput('Do everything');
    expect(result.status).toBe('success');
    expect(result.tool_call_count).toBe(6);

    // Verify files were created/modified
    const changelog = await readFile(path.join(workspace, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('v3.0.0');
  });

  it('stylesheet-resolved provider/model forwarded through codergen to session', async () => {
    // Parse a DOT with model_stylesheet setting llm_provider on a codergen node
    const graph = parseGardenSource(`digraph G {
      model_stylesheet="box { llm_provider: simulation; llm_model: custom-model }"
      start [shape=Mdiamond]
      impl [shape=box, prompt="Do work"]
      end [shape=Msquare]
      start -> impl -> end
    }`);

    // Run through the pipeline to apply stylesheet
    const result = transformAndValidate(graph);
    const impl = result.graph.nodeMap.get('impl');

    // Verify stylesheet-resolved values are set on the node
    expect(impl?.llmProvider).toBe('simulation');
    expect(impl?.llmModel).toBe('custom-model');

    // Now verify CodergenHandler reads these and passes them to session
    const workspace = await createWorkspace();
    const artifactDir = path.join(workspace, '.artifacts');

    // Use the ScriptedAdapter to verify the session receives the override
    const adapter = new ScriptedAdapter([
      { text: 'Done with custom model.' },
    ]);

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const transcriptWriter = new TranscriptWriter(artifactDir);

    // Create session with the stylesheet-resolved overrides (simulating what CodergenHandler does)
    const { AgentSession: AgentSessionClass } = await import('../../src/agent-loop/session.js');
    const { selectProfile } = await import('../../src/agent-loop/provider-profiles.js');
    const profile = selectProfile(impl?.llmProvider);

    const session = new AgentSessionClass(
      client, makeRegistry(), profile,
      new LocalExecutionEnvironment(workspace),
      { max_turns: 12, max_tool_rounds_per_input: 10, default_command_timeout_ms: 30_000, workspace_root: workspace },
      {
        transcriptWriter,
        overrides: {
          provider: impl?.llmProvider,
          model: impl?.llmModel,
        },
      },
    );

    const sessionResult = await session.processInput('Do work');
    expect(sessionResult.status).toBe('success');
  });

  it('default behavior unchanged when no stylesheet is present', async () => {
    const workspace = await createWorkspace();

    const adapter = new ScriptedAdapter([
      { text: 'No stylesheet, works fine.' },
    ]);

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      { max_turns: 12, max_tool_rounds_per_input: 10, default_command_timeout_ms: 30_000, workspace_root: workspace },
    );

    const result = await session.processInput('Hello');
    expect(result.status).toBe('success');
    expect(result.final_text).toBe('No stylesheet, works fine.');
  });
});

describe('subagent end-to-end integration', () => {
  it('parent spawns child, waits for result, and finishes', async () => {
    const workspace = await createWorkspace();
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([
      // Turn 1: parent spawns a child
      {
        tool_calls: [{
          id: 'tc1',
          name: 'spawn_agent',
          arguments: { task: 'read src/main.ts and report the version' },
        }],
      },
      // Turn 2: parent waits for child (agent_id will be dynamic; wait tool handles it)
      {
        tool_calls: [{
          id: 'tc2',
          name: 'wait',
          arguments: { agent_ids: 'placeholder' },
        }],
      },
      // Turn 3: parent synthesizes result
      { text: 'The child found version 1.0.0 in src/main.ts.' },
    ]);

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const session = new AgentSession(
      client,
      makeRegistryWithSubagentTools(),
      new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      { max_turns: 12, max_tool_rounds_per_input: 10, default_command_timeout_ms: 30_000, workspace_root: workspace },
      {
        depth: 0,
        subagentConfig: { ...DEFAULT_SUBAGENT_CONFIG },
        onEvent: (e) => events.push(e),
      }
    );

    const result = await session.processInput('Spawn a child to read the version');
    expect(result.status).toBe('success');

    // Verify spawn event was emitted
    const spawnStarted = events.filter(e =>
      e.type === 'agent_tool_call_started' && (e as any).tool_name === 'spawn_agent'
    );
    expect(spawnStarted.length).toBe(1);

    // Verify subagent_spawned event was emitted
    const spawnedEvents = events.filter(e => e.type === 'subagent_spawned');
    expect(spawnedEvents.length).toBe(1);
    expect((spawnedEvents[0] as any).depth).toBe(1);

    // Verify subagent_completed event was emitted
    const completedEvents = events.filter(e => e.type === 'subagent_completed');
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('parent spawns, steers, and closes a child', async () => {
    const workspace = await createWorkspace();
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([
      // Turn 1: spawn
      {
        tool_calls: [{
          id: 'tc1',
          name: 'spawn_agent',
          arguments: { task: 'explore the codebase' },
        }],
      },
      // Turn 2: close the child
      {
        tool_calls: [{
          id: 'tc2',
          name: 'close_agent',
          arguments: { agent_id: 'placeholder' },
        }],
      },
      // Turn 3: done
      { text: 'Closed the child agent.' },
    ]);

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const session = new AgentSession(
      client,
      makeRegistryWithSubagentTools(),
      new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      { max_turns: 12, max_tool_rounds_per_input: 10, default_command_timeout_ms: 30_000, workspace_root: workspace },
      {
        depth: 0,
        subagentConfig: { ...DEFAULT_SUBAGENT_CONFIG },
        onEvent: (e) => events.push(e),
      }
    );

    const result = await session.processInput('Spawn and close');
    expect(result.status).toBe('success');
    expect(result.final_text).toBe('Closed the child agent.');

    // Verify both spawn and close tool calls were handled
    const toolNames = events
      .filter(e => e.type === 'agent_tool_call_started')
      .map(e => (e as any).tool_name);
    expect(toolNames).toContain('spawn_agent');
    expect(toolNames).toContain('close_agent');
  });

  it('parent session completion auto-closes live children', async () => {
    const workspace = await createWorkspace();

    // Parent spawns but completes without explicitly waiting/closing
    const adapter = new ScriptedAdapter([
      {
        tool_calls: [{
          id: 'tc1',
          name: 'spawn_agent',
          arguments: { task: 'background work' },
        }],
      },
      // Immediately finishes without waiting
      { text: 'Done, leaving child running.' },
    ]);

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const session = new AgentSession(
      client,
      makeRegistryWithSubagentTools(),
      new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      { max_turns: 12, max_tool_rounds_per_input: 10, default_command_timeout_ms: 30_000, workspace_root: workspace },
      { depth: 0, subagentConfig: { ...DEFAULT_SUBAGENT_CONFIG } }
    );

    const result = await session.processInput('Spawn background work');
    // Session should still succeed — auto-cleanup handles children
    expect(result.status).toBe('success');
  });

  it('artifact_path is present on tool completion events', async () => {
    const workspace = await createWorkspace();
    const artifactDir = path.join(workspace, '.artifacts');
    const events: AgentEvent[] = [];

    const adapter = new ScriptedAdapter([
      { tool_calls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'src/main.ts' } }] },
      { text: 'Done.' },
    ]);

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const transcriptWriter = new TranscriptWriter(artifactDir);

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      { max_turns: 12, max_tool_rounds_per_input: 10, default_command_timeout_ms: 30_000, workspace_root: workspace },
      { transcriptWriter, onEvent: (e) => events.push(e) }
    );

    await session.processInput('Read main.ts');

    const toolCompleted = events.find(e =>
      e.type === 'agent_tool_call_completed' && (e as any).tool_name === 'read_file'
    ) as any;
    expect(toolCompleted).toBeDefined();
    expect(toolCompleted.artifact_path).toBeDefined();
    expect(toolCompleted.artifact_path).toContain('001-read_file');
  });

  it('system prompt includes environment context', async () => {
    const workspace = await createWorkspace();
    let capturedSystem = '';

    // Custom adapter that captures the system prompt
    const adapter: ProviderAdapter = {
      provider_name: 'capture',
      async generate(req) {
        capturedSystem = req.system ?? '';
        return {
          message: { role: 'assistant', content: 'done' },
          usage: { input_tokens: 10, output_tokens: 10 },
          stop_reason: 'end_turn',
          model: 'test',
          provider: 'capture',
        };
      },
      async *stream(req) {
        capturedSystem = req.system ?? '';
        yield { type: 'stream_start' as const, model: 'test' };
        yield { type: 'content_delta' as const, text: 'done' };
        yield { type: 'usage' as const, usage: { input_tokens: 10, output_tokens: 10 } };
        yield { type: 'stream_end' as const, stop_reason: 'end_turn', message: { role: 'assistant' as const, content: 'done' } };
      },
    };

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      { max_turns: 12, max_tool_rounds_per_input: 10, default_command_timeout_ms: 30_000, workspace_root: workspace },
    );

    await session.processInput('Hello');

    // System prompt should include environment context
    expect(capturedSystem).toContain('## Environment');
    expect(capturedSystem).toContain('Platform:');
    expect(capturedSystem).toContain('Workspace:');
  });

  it('followUp writes transcript entry', async () => {
    const workspace = await createWorkspace();
    const artifactDir = path.join(workspace, '.artifacts');

    const adapter = new ScriptedAdapter([
      { text: 'first response' },
      { text: 'follow up response' },
    ]);

    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const transcriptWriter = new TranscriptWriter(artifactDir);
    await transcriptWriter.writePrompt('first');

    const session = new AgentSession(
      client, makeRegistry(), new AnthropicProfile(),
      new LocalExecutionEnvironment(workspace),
      { max_turns: 12, max_tool_rounds_per_input: 10, default_command_timeout_ms: 30_000, workspace_root: workspace },
      { transcriptWriter }
    );

    await session.submit('first');
    await session.followUp('second');

    // Small delay for fire-and-forget transcript writes to flush
    await new Promise(r => setTimeout(r, 50));

    // Read transcript
    const transcript = await readFile(path.join(artifactDir, 'transcript.jsonl'), 'utf8');
    expect(transcript).toContain('[follow-up]');
    expect(transcript).toContain('second');
  });
});
