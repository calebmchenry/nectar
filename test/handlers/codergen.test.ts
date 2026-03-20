import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodergenHandler } from '../../src/handlers/codergen.js';
import { SimulationProvider } from '../../src/llm/simulation.js';
import { UnifiedClient } from '../../src/llm/client.js';
import { GardenNode } from '../../src/garden/types.js';
import type { LLMClient, LLMRequest, LLMResponse } from '../../src/llm/types.js';
import type { ProviderAdapter } from '../../src/llm/adapters/types.js';
import { selectProfile } from '../../src/agent-loop/provider-profiles.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-codergen-test-'));
  tempDirs.push(dir);
  return dir;
}

function codergenNode(overrides: Partial<GardenNode> = {}): GardenNode {
  return {
    id: overrides.id ?? 'llm_node',
    kind: 'codergen',
    shape: 'box',
    attributes: overrides.attributes ?? {},
    prompt: 'prompt' in overrides ? overrides.prompt : 'Write a hello world program',
    label: overrides.label
  };
}

describe('CodergenHandler', () => {
  describe('with legacy LLMClient', () => {
    it('executes with SimulationProvider and writes artifacts', async () => {
      const runDir = await createTempDir();
      const handler = new CodergenHandler(new SimulationProvider());

      const outcome = await handler.execute({
        node: codergenNode(),
        run_id: 'test-run',
        dot_file: 'test.dot',
        attempt: 1,
        run_dir: runDir,
        context: {}
      });

      expect(outcome.status).toBe('success');
      expect(outcome.context_updates).toBeDefined();

      const nodeDir = path.join(runDir, 'llm_node');
      const prompt = await readFile(path.join(nodeDir, 'prompt.md'), 'utf8');
      expect(prompt).toBe('Write a hello world program');

      const response = await readFile(path.join(nodeDir, 'response.md'), 'utf8');
      expect(response).toContain('Simulated response');

      const status = JSON.parse(await readFile(path.join(nodeDir, 'status.json'), 'utf8'));
      expect(status.status).toBe('success');
      expect(status.model).toContain('simulated');
    });

    it('returns failure when prompt is missing', async () => {
      const runDir = await createTempDir();
      const handler = new CodergenHandler(new SimulationProvider());

      const outcome = await handler.execute({
        node: codergenNode({ prompt: undefined, attributes: {} }),
        run_id: 'test-run',
        dot_file: 'test.dot',
        attempt: 1,
        run_dir: runDir,
        context: {}
      });

      expect(outcome.status).toBe('failure');
      expect(outcome.error_message).toContain('missing a prompt');
    });

    it('returns failure on empty LLM response', async () => {
      const runDir = await createTempDir();

      const emptyClient: LLMClient = {
        async generate(_req: LLMRequest): Promise<LLMResponse> {
          return { content: '', model: 'test', usage: { input_tokens: 0, output_tokens: 0 } };
        }
      };

      const handler = new CodergenHandler(emptyClient);

      const outcome = await handler.execute({
        node: codergenNode(),
        run_id: 'test-run',
        dot_file: 'test.dot',
        attempt: 1,
        run_dir: runDir,
        context: {}
      });

      expect(outcome.status).toBe('failure');
      expect(outcome.error_message).toContain('empty LLM response');
    });

    it('returns failure on LLM error', async () => {
      const runDir = await createTempDir();

      const errorClient: LLMClient = {
        async generate(_req: LLMRequest): Promise<LLMResponse> {
          throw new Error('API connection failed');
        }
      };

      const handler = new CodergenHandler(errorClient);

      const outcome = await handler.execute({
        node: codergenNode(),
        run_id: 'test-run',
        dot_file: 'test.dot',
        attempt: 1,
        run_dir: runDir,
        context: {}
      });

      expect(outcome.status).toBe('failure');
      expect(outcome.error_message).toContain('API connection failed');
    });
  });

  describe('with UnifiedClient', () => {
    it('streams response and writes artifacts incrementally', async () => {
      const runDir = await createTempDir();
      const sim = new SimulationProvider();
      const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', sim]]));
      const handler = new CodergenHandler(client);

      const outcome = await handler.execute({
        node: codergenNode(),
        run_id: 'test-run',
        dot_file: 'test.dot',
        attempt: 1,
        run_dir: runDir,
        context: {}
      });

      expect(outcome.status).toBe('success');
      expect(outcome.context_updates).toBeDefined();

      const nodeDir = path.join(runDir, 'llm_node');
      const response = await readFile(path.join(nodeDir, 'response.md'), 'utf8');
      expect(response).toContain('Simulated response');

      const status = JSON.parse(await readFile(path.join(nodeDir, 'status.json'), 'utf8'));
      expect(status.status).toBe('success');
      expect(status.usage).toBeDefined();
    });

    it('reads llm_provider and llm_model from node attributes', async () => {
      const runDir = await createTempDir();
      const sim = new SimulationProvider();
      const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', sim]]));
      const handler = new CodergenHandler(client);

      const outcome = await handler.execute({
        node: codergenNode({
          attributes: { llm_provider: 'simulation', llm_model: 'custom-model' }
        }),
        run_id: 'test-run',
        dot_file: 'test.dot',
        attempt: 1,
        run_dir: runDir,
        context: {}
      });

      expect(outcome.status).toBe('success');
    });

    it('does not mutate shared profile when node sets llm_model', async () => {
      const runDir = await createTempDir();
      const sim = new SimulationProvider();
      const client = new UnifiedClient(new Map<string, ProviderAdapter>([['simulation', sim]]));

      // Record original default model
      const profileBefore = selectProfile('simulation');
      const originalModel = profileBefore.defaultModel;

      const handler = new CodergenHandler(client);
      await handler.execute({
        node: codergenNode({
          attributes: { llm_provider: 'simulation', llm_model: 'custom-override-model' }
        }),
        run_id: 'test-run',
        dot_file: 'test.dot',
        attempt: 1,
        run_dir: runDir,
        context: {}
      });

      // The shared profile must not have been mutated
      const profileAfter = selectProfile('simulation');
      expect(profileAfter.defaultModel).toBe(originalModel);
    });
  });
});
