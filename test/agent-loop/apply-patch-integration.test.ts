import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/agent-loop/tool-registry.js';
import { LocalExecutionEnvironment } from '../../src/agent-loop/execution-environment.js';
import { applyPatchHandler, applyPatchSchema, applyPatchDescription } from '../../src/agent-loop/tools/apply-patch.js';
import { OpenAIProfile, AnthropicProfile, GeminiProfile } from '../../src/agent-loop/provider-profiles.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-apply-patch-'));
  tempDirs.push(dir);
  return dir;
}

describe('apply_patch tool integration', () => {
  it('executes through tool registry', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'hello.ts'), 'const msg = "hello";\n', 'utf8');

    const registry = new ToolRegistry();
    registry.register('apply_patch', applyPatchDescription, applyPatchSchema, applyPatchHandler);

    const env = new LocalExecutionEnvironment(workspace);
    const result = await registry.execute({
      name: 'apply_patch',
      call_id: 'test-1',
      arguments: {
        patch: `*** Begin Patch
*** Update File: hello.ts
@@
-const msg = "hello";
+const msg = "world";
*** End Patch`,
      },
    }, env);

    expect(result.is_error).toBe(false);
    expect(result.content).toContain('Patch applied successfully');

    const content = await readFile(path.join(workspace, 'hello.ts'), 'utf8');
    expect(content).toContain('"world"');
  });

  it('returns error for invalid patch', async () => {
    const workspace = await createWorkspace();
    const registry = new ToolRegistry();
    registry.register('apply_patch', applyPatchDescription, applyPatchSchema, applyPatchHandler);

    const env = new LocalExecutionEnvironment(workspace);
    const result = await registry.execute({
      name: 'apply_patch',
      call_id: 'test-2',
      arguments: { patch: 'not a valid patch' },
    }, env);

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Patch parse error');
  });
});

describe('Provider profile tool exposure', () => {
  it('OpenAI profile exposes apply_patch, not edit_file', () => {
    const profile = new OpenAIProfile();
    expect(profile.visibleTools).toContain('apply_patch');
    expect(profile.visibleTools).not.toContain('edit_file');
  });

  it('Anthropic profile exposes edit_file, not apply_patch', () => {
    const profile = new AnthropicProfile();
    expect(profile.visibleTools).toContain('edit_file');
    expect(profile.visibleTools).not.toContain('apply_patch');
  });

  it('Gemini profile exposes edit_file, not apply_patch', () => {
    const profile = new GeminiProfile();
    expect(profile.visibleTools).toContain('edit_file');
    expect(profile.visibleTools).not.toContain('apply_patch');
  });

  it('registry.definitionsForProfile filters tools', () => {
    const registry = new ToolRegistry();
    registry.register('read_file', 'Read file', {}, async () => '');
    registry.register('edit_file', 'Edit file', {}, async () => '');
    registry.register('apply_patch', 'Apply patch', {}, async () => '');

    const openaiDefs = registry.definitionsForProfile(['read_file', 'apply_patch']);
    expect(openaiDefs.map(d => d.name)).toEqual(['read_file', 'apply_patch']);

    const anthropicDefs = registry.definitionsForProfile(['read_file', 'edit_file']);
    expect(anthropicDefs.map(d => d.name)).toEqual(['read_file', 'edit_file']);
  });
});
