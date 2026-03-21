import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SwarmAnalysisService } from '../../src/runtime/swarm-analysis-service.js';
import { parseAnalysisDocument } from '../../src/seedbed/analysis-document.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-swarm-runtime-'));
  tempDirs.push(dir);
  await mkdir(path.join(dir, 'seedbed'), { recursive: true });
  await mkdir(path.join(dir, 'honey'), { recursive: true });
  return dir;
}

describe('SwarmAnalysisService', () => {
  it('writes skipped analyses when provider credentials are missing', async () => {
    const ws = await workspace();
    const service = new SwarmAnalysisService({
      workspace_root: ws,
      provider_targets: {
        claude: { llm_provider: 'missing-anthropic' },
        codex: { llm_provider: 'missing-openai' },
        gemini: { llm_provider: 'missing-gemini' },
      },
    });

    const created = await service.store.create({
      title: 'Missing providers',
      body: 'Analyze without configured providers',
      tags: ['swarm'],
      priority: 'high',
    });

    const results = await service.analyzeSeed({
      seed_id: created.id,
      providers: ['claude', 'codex', 'gemini'],
      include_attachments: false,
    });

    expect(results).toHaveLength(3);
    expect(results.every((result) => result.status === 'skipped')).toBe(true);

    const listed = await service.store.list();
    const seedDir = listed.find((entry) => entry.meta.id === created.id)?.dirPath;
    expect(seedDir).toBeTruthy();

    const claudeDoc = await readFile(path.join(seedDir!, 'analysis', 'claude.md'), 'utf8');
    const parsedClaude = parseAnalysisDocument(claudeDoc);
    expect(parsedClaude.status).toBe('skipped');
    expect(parsedClaude.error).toMatch(/not configured/i);

    const seed = await service.store.get(created.id);
    expect(seed?.meta.analysis_status.claude).toBe('skipped');
    expect(seed?.meta.analysis_status.codex).toBe('skipped');
    expect(seed?.meta.analysis_status.gemini).toBe('skipped');
  });

  it('skips rewriting complete analyses when force=false', async () => {
    const ws = await workspace();
    const service = new SwarmAnalysisService({
      workspace_root: ws,
    });

    const created = await service.store.create({
      title: 'Force behavior',
      body: 'Do not overwrite complete analysis',
    });

    const listed = await service.store.list();
    const seedDir = listed.find((entry) => entry.meta.id === created.id)?.dirPath;
    expect(seedDir).toBeTruthy();

    const analysisPath = path.join(seedDir!, 'analysis', 'claude.md');
    const existingDoc = [
      '---',
      'provider: claude',
      'generated_at: 2026-03-21T00:00:00.000Z',
      'status: complete',
      'recommended_priority: high',
      'estimated_complexity: medium',
      'feasibility: high',
      '---',
      '',
      '# Summary',
      '',
      'Existing summary.',
      '',
      '# Implementation Approach',
      '',
      'Existing approach.',
      '',
      '# Risks',
      '',
      'Existing risks.',
      '',
      '# Open Questions',
      '',
      'Existing questions.',
      '',
    ].join('\n');
    await writeFile(analysisPath, existingDoc, 'utf8');
    await service.store.patch(created.id, {
      analysis_status: {
        claude: 'complete',
      },
    });

    const results = await service.analyzeSeed({
      seed_id: created.id,
      providers: ['claude'],
      include_attachments: false,
      force: false,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('complete');
    expect(results[0]?.message).toMatch(/already complete/i);

    const after = await readFile(analysisPath, 'utf8');
    expect(after).toBe(existingDoc);
  });

  it('recovers stale running statuses to failed and writes failure docs', async () => {
    const ws = await workspace();
    const service = new SwarmAnalysisService({
      workspace_root: ws,
    });

    const created = await service.store.create({
      title: 'Recover running',
      body: 'Recover stale statuses',
    });

    await service.store.patch(created.id, {
      analysis_status: {
        claude: 'running',
      },
    });

    const recovered = await service.recoverStaleRunningStatuses('server restarted');
    expect(recovered).toBeGreaterThanOrEqual(1);

    const seed = await service.store.get(created.id);
    expect(seed?.meta.analysis_status.claude).toBe('failed');

    const listed = await service.store.list();
    const seedDir = listed.find((entry) => entry.meta.id === created.id)?.dirPath;
    expect(seedDir).toBeTruthy();

    const doc = await readFile(path.join(seedDir!, 'analysis', 'claude.md'), 'utf8');
    const parsed = parseAnalysisDocument(doc);
    expect(parsed.status).toBe('failed');
    expect(parsed.error).toContain('server restarted');
  });
});
