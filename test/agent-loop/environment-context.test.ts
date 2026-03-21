import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEnvironmentContext, buildGitSnapshot } from '../../src/agent-loop/environment-context.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('buildEnvironmentContext', () => {
  it('includes required environment fields', async () => {
    const result = await buildEnvironmentContext({
      workspaceRoot: '/tmp/test',
      provider: 'openai',
      model: 'gpt-4o',
      visibleToolNames: ['read_file', 'shell'],
    });

    expect(result).toContain('Working directory: /tmp/test');
    expect(result).toContain('Is git repository:');
    expect(result).toContain('Git branch:');
    expect(result).toContain('Platform:');
    expect(result).toContain('OS version:');
    expect(result).toContain(`Today's date:`);
    expect(result).toContain('Model: gpt-4o');
    expect(result).toContain('Knowledge cutoff:');
    expect(result).toContain('Tools: read_file, shell');
  });

  it('renders unknown knowledge cutoff when model is not in catalog', async () => {
    const result = await buildEnvironmentContext({
      workspaceRoot: '/tmp/test',
      model: 'model-that-does-not-exist',
    });
    expect(result).toContain('Knowledge cutoff: unknown');
  });
});

describe('buildGitSnapshot', () => {
  it('returns null for non-git directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-git-test-'));
    tempDirs.push(dir);

    const result = await buildGitSnapshot(dir);
    expect(result).toBeNull();
  });

  it('returns git info for a git repo (this test repo)', async () => {
    // Use the actual nectar repo root
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const result = await buildGitSnapshot(repoRoot);

    if (result === null) {
      // If git not available in test env, skip
      return;
    }

    expect(result).toContain('Branch:');
    expect(result).toContain('Git Status');
  });
});
