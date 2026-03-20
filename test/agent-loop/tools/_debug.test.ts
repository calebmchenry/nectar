import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { globHandler } from '../../../src/agent-loop/tools/glob.js';
import { LocalExecutionEnvironment } from '../../../src/agent-loop/execution-environment.js';

describe('debug glob handler', () => {
  it('finds nested TS files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'debug-glob2-'));
    const env = new LocalExecutionEnvironment(dir);
    console.log('workspace:', env.workspaceRoot);
    await mkdir(path.join(env.workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(env.workspaceRoot, 'src', 'main.ts'), 'x', 'utf8');
    await writeFile(path.join(env.workspaceRoot, 'src', 'style.css'), 'x', 'utf8');
    
    // Test *.ts first (simpler)
    const r1 = await globHandler({ pattern: '*.ts' }, env);
    console.log('*.ts result:', JSON.stringify(r1));
    
    // Test **/*.ts
    const r2 = await globHandler({ pattern: '**/*.ts' }, env);
    console.log('**/*.ts result:', JSON.stringify(r2));
    
    // Test **/*
    const r3 = await globHandler({ pattern: '**/*' }, env);
    console.log('**/* result:', JSON.stringify(r3));
    
    await rm(dir, { recursive: true, force: true });
  });
});
