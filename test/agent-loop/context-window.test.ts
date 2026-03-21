import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UnifiedClient } from '../../src/llm/client.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import { ScriptedAdapter } from '../helpers/scripted-adapter.js';
import { AgentSession } from '../../src/agent-loop/session.js';
import { ToolRegistry } from '../../src/agent-loop/tool-registry.js';
import { AnthropicProfile } from '../../src/agent-loop/provider-profiles.js';
import { LocalExecutionEnvironment } from '../../src/agent-loop/execution-environment.js';
import type { AgentEvent } from '../../src/agent-loop/events.js';
import { getModelInfo } from '../../src/llm/catalog.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-context-window-'));
  tempDirs.push(dir);
  return dir;
}

describe('AgentSession context window warning', () => {
  it('emits context_window_warning once when estimated usage exceeds 80%', async () => {
    const workspace = await createWorkspace();
    const adapter = new ScriptedAdapter([{ text: 'ok' }]);
    const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', adapter]]));
    const events: AgentEvent[] = [];
    const profile = new AnthropicProfile();
    const modelInfo = getModelInfo(profile.defaultModel ?? '', profile.name) ?? { context_window: 200_000 };
    const promptChars = Math.ceil(modelInfo.context_window * 4 * 0.85);

    const session = new AgentSession(
      client,
      new ToolRegistry(),
      profile,
      new LocalExecutionEnvironment(workspace),
      {
        max_turns: 3,
        max_tool_rounds_per_input: 2,
        default_command_timeout_ms: 20_000,
        workspace_root: workspace,
      },
      {
        onEvent: (event) => events.push(event),
      }
    );

    const veryLargePrompt = 'x'.repeat(promptChars);
    await session.processInput(veryLargePrompt);

    const warnings = events.filter((event) => event.type === 'context_window_warning');
    expect(warnings).toHaveLength(1);
    if (warnings[0]?.type === 'context_window_warning') {
      expect(warnings[0].usage_pct).toBeGreaterThanOrEqual(80);
      expect(warnings[0].estimated_tokens).toBeGreaterThan(0);
      expect(warnings[0].context_window).toBeGreaterThan(0);
    }

    const agentWarnings = events.filter((event) => event.type === 'agent_warning');
    expect(agentWarnings).toHaveLength(1);
    if (agentWarnings[0]?.type === 'agent_warning') {
      expect(agentWarnings[0].code).toBe('context_window_pressure');
    }
  });
});
