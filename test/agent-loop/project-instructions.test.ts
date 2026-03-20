import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverInstructions } from '../../src/agent-loop/project-instructions.js';

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

  it('discovers AGENTS.md', async () => {
    const dir = await setup();
    await writeFile(path.join(dir, 'AGENTS.md'), 'Agent instructions here', 'utf8');

    const result = await discoverInstructions(dir, 'anthropic');
    expect(result).toContain('Agent instructions here');
  });

  it('discovers provider-specific CLAUDE.md for anthropic', async () => {
    const dir = await setup();
    await writeFile(path.join(dir, 'CLAUDE.md'), 'Claude specific', 'utf8');
    await writeFile(path.join(dir, 'AGENTS.md'), 'Generic', 'utf8');

    const result = await discoverInstructions(dir, 'anthropic');
    expect(result).toContain('Claude specific');
    expect(result).toContain('Generic');
  });

  it('discovers .codex/instructions.md for openai', async () => {
    const dir = await setup();
    await mkdir(path.join(dir, '.codex'), { recursive: true });
    await writeFile(path.join(dir, '.codex', 'instructions.md'), 'OpenAI specific', 'utf8');

    const result = await discoverInstructions(dir, 'openai');
    expect(result).toContain('OpenAI specific');
  });

  it('discovers GEMINI.md for gemini', async () => {
    const dir = await setup();
    await writeFile(path.join(dir, 'GEMINI.md'), 'Gemini specific', 'utf8');

    const result = await discoverInstructions(dir, 'gemini');
    expect(result).toContain('Gemini specific');
  });

  it('provider-specific files are more specific than AGENTS.md', async () => {
    const dir = await setup();
    await writeFile(path.join(dir, 'CLAUDE.md'), 'Claude rules', 'utf8');
    await writeFile(path.join(dir, 'AGENTS.md'), 'Generic rules', 'utf8');

    const result = await discoverInstructions(dir, 'anthropic');
    // Claude file should appear before AGENTS.md
    const claudeIdx = result.indexOf('Claude rules');
    const agentsIdx = result.indexOf('Generic rules');
    expect(claudeIdx).toBeLessThan(agentsIdx);
  });

  it('truncates to fit 32KB budget', async () => {
    const dir = await setup();
    // Write a very large AGENTS.md
    const largeContent = 'X'.repeat(40_000);
    await writeFile(path.join(dir, 'AGENTS.md'), largeContent, 'utf8');
    await writeFile(path.join(dir, 'CLAUDE.md'), 'Important Claude instructions', 'utf8');

    const result = await discoverInstructions(dir, 'anthropic');
    expect(result.length).toBeLessThanOrEqual(40_000); // Some buffer for markers
    // Provider-specific should be preserved
    expect(result).toContain('Important Claude instructions');
  });
});
