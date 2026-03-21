import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineService } from '../../src/runtime/pipeline-service.js';
import { UnifiedClient } from '../../src/llm/client.js';
import { AutoApproveInterviewer } from '../../src/interviewer/auto-approve.js';
import { canListenOnLoopback } from '../helpers/network.js';
import { startMockChatCompletionsServer, type MockChatCompletionsServer } from '../helpers/mock-chat-completions.js';

const tempDirs: string[] = [];
const servers: MockChatCompletionsServer[] = [];

const originalEnv = process.env;

afterEach(async () => {
  process.env = originalEnv;
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nectar-openai-compatible-int-'));
  tempDirs.push(workspace);
  await mkdir(path.join(workspace, 'gardens'), { recursive: true });
  return workspace;
}

describe('openai-compatible integration', () => {
  it('executes a codergen pipeline against a mock chat-completions server', async () => {
    if (!(await canListenOnLoopback())) {
      return;
    }

    const server = await startMockChatCompletionsServer((request) => {
      const body = request.body as Record<string, unknown>;
      const stream = Boolean(body.stream);

      if (stream) {
        return {
          sse: [
            'data: {"id":"chatcmpl-stream","model":"mock-model","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}',
            'data: [DONE]',
          ],
        };
      }

      return {
        json: {
          id: 'chatcmpl-plain',
          model: 'mock-model',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'done',
              },
            },
          ],
          usage: {
            prompt_tokens: 9,
            completion_tokens: 2,
          },
        },
      };
    });
    servers.push(server);

    const workspace = await createWorkspace();
    const gardenPath = path.join(workspace, 'gardens', 'compatible.dot');
    await writeFile(
      gardenPath,
      `digraph Compatible {
        start [shape=Mdiamond]
        draft [shape=box, prompt="Write a one-line status update", llm_provider="openai_compatible", llm_model="mock-model"]
        done [shape=Msquare]
        start -> draft -> done
      }`,
      'utf8',
    );

    process.env = {
      ...originalEnv,
      OPENAI_COMPATIBLE_BASE_URL: server.baseUrl,
      OPENAI_COMPATIBLE_API_KEY: 'test-key',
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    };

    const service = new PipelineService(workspace);
    const load = await service.loadFromPath('gardens/compatible.dot');
    expect(load.graph).toBeTruthy();
    expect(load.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toHaveLength(0);

    const llmClient = UnifiedClient.from_env();
    const runResult = await service.executePipeline({
      graph: load.graph!,
      graph_hash: load.graph_hash ?? '',
      graph_hash_kind: load.graph_hash_kind,
      prepared_dot: load.prepared_dot,
      source_files: load.source_files,
      interviewer: new AutoApproveInterviewer(),
      llm_client: llmClient,
      register_signal_handlers: false,
    });

    expect(runResult.status).toBe('completed');
    expect(server.requests.length).toBeGreaterThan(0);
    const firstRequestBody = server.requests[0]?.body as Record<string, unknown>;
    expect(firstRequestBody.model).toBe('mock-model');
  });
});
