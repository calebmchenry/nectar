import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverInstructions } from '../../src/agent-loop/project-instructions.js';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function setup(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-instructions-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('discoverInstructions', () => {
  it('returns empty string when no instruction files exist', async () => {
    const dir = await setup();
    const result = await discoverInstructions(dir, 'anthropic');
    expect(result).toBe('');
  });

  it('walks from repo root to cwd with deeper/provider-specific precedence', async () => {
    const dir = await setup();
    const apiDir = path.join(dir, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });

    await writeFile(path.join(dir, 'AGENTS.md'), 'root generic', 'utf8');
    await writeFile(path.join(dir, 'CLAUDE.md'), 'root provider', 'utf8');
    await writeFile(path.join(apiDir, 'AGENTS.md'), 'api generic', 'utf8');
    await writeFile(path.join(apiDir, 'CLAUDE.md'), 'api provider', 'utf8');

    await execFile('git', ['init'], { cwd: dir });

    const result = await discoverInstructions(dir, 'anthropic', apiDir);
    const rootGenericIdx = result.indexOf('root generic');
    const rootProviderIdx = result.indexOf('root provider');
    const apiGenericIdx = result.indexOf('api generic');
    const apiProviderIdx = result.indexOf('api provider');

    expect(rootGenericIdx).toBeGreaterThan(-1);
    expect(rootProviderIdx).toBeGreaterThan(rootGenericIdx);
    expect(apiGenericIdx).toBeGreaterThan(rootProviderIdx);
    expect(apiProviderIdx).toBeGreaterThan(apiGenericIdx);
  });

  it('falls back to workspace_root when cwd is outside a git repo', async () => {
    const dir = await setup();
    const nestedDir = path.join(dir, 'packages', 'api');
    await mkdir(nestedDir, { recursive: true });

    await writeFile(path.join(dir, 'AGENTS.md'), 'workspace generic', 'utf8');
    await writeFile(path.join(nestedDir, 'CLAUDE.md'), 'nested provider', 'utf8');

    const result = await discoverInstructions(dir, 'anthropic', nestedDir);
    expect(result).toContain('workspace generic');
    expect(result).toContain('nested provider');
    expect(result.indexOf('workspace generic')).toBeLessThan(result.indexOf('nested provider'));
  });

  it('falls back to workspace_root when git is unavailable', async () => {
    const dir = await setup();
    const nestedDir = path.join(dir, 'pkg');
    await mkdir(nestedDir, { recursive: true });

    await writeFile(path.join(dir, 'AGENTS.md'), 'fallback root', 'utf8');
    await writeFile(path.join(nestedDir, 'CLAUDE.md'), 'fallback nested', 'utf8');

    const result = await discoverInstructions(
      dir,
      'anthropic',
      nestedDir,
      async () => {
        throw new Error('git not installed');
      },
    );

    expect(result).toContain('fallback root');
    expect(result).toContain('fallback nested');
    expect(result.indexOf('fallback root')).toBeLessThan(result.indexOf('fallback nested'));
  });

  it('preserves highest-precedence files when enforcing 32KB budget', async () => {
    const dir = await setup();
    const nestedDir = path.join(dir, 'nested');
    await mkdir(path.join(nestedDir, '.codex'), { recursive: true });

    await writeFile(path.join(dir, 'AGENTS.md'), 'x'.repeat(40_000), 'utf8');
    await writeFile(path.join(nestedDir, '.codex', 'instructions.md'), 'openai nested winner', 'utf8');

    const result = await discoverInstructions(dir, 'openai', nestedDir);
    expect(result).toContain('openai nested winner');
    expect(result).not.toContain(`--- ${path.join(dir, 'AGENTS.md')} ---`);
  });

  it('orders AGENTS.md before provider-specific file in the same directory', async () => {
    const dir = await setup();
    await mkdir(path.join(dir, '.codex'), { recursive: true });
    await writeFile(path.join(dir, 'AGENTS.md'), 'generic instructions', 'utf8');
    await writeFile(path.join(dir, '.codex', 'instructions.md'), 'provider instructions', 'utf8');

    const result = await discoverInstructions(dir, 'openai', dir);
    expect(result).toContain('generic instructions');
    expect(result).toContain('provider instructions');
    expect(result.indexOf('generic instructions')).toBeLessThan(result.indexOf('provider instructions'));
  });
});
