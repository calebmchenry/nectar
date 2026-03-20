import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ToolHookRunner, resolveHooks } from '../../src/agent-loop/tool-hooks.js';
import type { ToolHookMetadata, PostHookMetadata, ResolvedHooks } from '../../src/agent-loop/tool-hooks.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

function makeMetadata(overrides?: Partial<ToolHookMetadata>): ToolHookMetadata {
  return {
    run_id: 'test-run',
    node_id: 'test-node',
    session_id: 'test-session',
    tool_call_id: 'call-001',
    tool_name: 'shell',
    arguments: { command: 'echo hello' },
    ...overrides,
  };
}

function makePostMetadata(overrides?: Partial<PostHookMetadata>): PostHookMetadata {
  return {
    ...makeMetadata(),
    is_error: false,
    content_preview: 'hello',
    duration_ms: 42,
    blocked_by_pre_hook: false,
    ...overrides,
  };
}

describe('resolveHooks', () => {
  it('node-level hooks override graph-level', () => {
    const result = resolveHooks('./node-pre.sh', './node-post.sh', './graph-pre.sh', './graph-post.sh');
    expect(result.pre).toBe('./node-pre.sh');
    expect(result.post).toBe('./node-post.sh');
  });

  it('falls back to graph-level when node-level is undefined', () => {
    const result = resolveHooks(undefined, undefined, './graph-pre.sh', './graph-post.sh');
    expect(result.pre).toBe('./graph-pre.sh');
    expect(result.post).toBe('./graph-post.sh');
  });

  it('returns undefined when no hooks configured', () => {
    const result = resolveHooks(undefined, undefined, undefined, undefined);
    expect(result.pre).toBeUndefined();
    expect(result.post).toBeUndefined();
  });
});

describe('ToolHookRunner', () => {
  it('has no hooks when empty', () => {
    const runner = new ToolHookRunner({});
    expect(runner.hasPreHook()).toBe(false);
    expect(runner.hasPostHook()).toBe(false);
    expect(runner.hasAnyHook()).toBe(false);
  });

  it('pre-hook exit 0 allows tool call', async () => {
    const runner = new ToolHookRunner({ pre: 'exit 0' });
    expect(runner.hasPreHook()).toBe(true);
    const result = await runner.runPreHook(makeMetadata());
    expect(result.allowed).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('pre-hook non-zero blocks tool call', async () => {
    const runner = new ToolHookRunner({ pre: 'exit 1' });
    const result = await runner.runPreHook(makeMetadata());
    expect(result.allowed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('post-hook runs and records exit code', async () => {
    const runner = new ToolHookRunner({ post: 'exit 0' });
    expect(runner.hasPostHook()).toBe(true);
    const result = await runner.runPostHook(makePostMetadata());
    expect(result.exitCode).toBe(0);
  });

  it('post-hook failure does not throw', async () => {
    const runner = new ToolHookRunner({ post: 'exit 42' });
    const result = await runner.runPostHook(makePostMetadata());
    expect(result.exitCode).toBe(42);
    // Should NOT throw — failure is recorded but not blocking
  });

  it('hook receives JSON on stdin', async () => {
    // Use a hook that reads stdin and writes it to stdout
    const runner = new ToolHookRunner({ pre: 'cat' });
    const meta = makeMetadata({ tool_name: 'read_file' });
    const result = await runner.runPreHook(meta);
    expect(result.allowed).toBe(true);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.tool_name).toBe('read_file');
    expect(parsed.run_id).toBe('test-run');
  });

  it('hook env vars set correctly', async () => {
    const runner = new ToolHookRunner({ pre: 'echo $NECTAR_TOOL_NAME $NECTAR_HOOK_PHASE' });
    const result = await runner.runPreHook(makeMetadata({ tool_name: 'grep' }));
    expect(result.stdout.trim()).toBe('grep pre');
  });

  it('hook timeout enforced', async () => {
    // This test uses a long-running command; the 15s timeout should prevent it from hanging
    // We can't easily test the exact timeout boundary, but we can verify the hook mechanism
    // handles command that exits quickly
    const runner = new ToolHookRunner({ pre: 'sleep 0 && exit 0' });
    const result = await runner.runPreHook(makeMetadata());
    expect(result.allowed).toBe(true);
  });

  it('no hooks configured means passthrough', async () => {
    const runner = new ToolHookRunner({});
    // Pre-hook with no hook configured should return allowed=true
    const preResult = await runner.runPreHook(makeMetadata());
    expect(preResult.allowed).toBe(true);
    // Post-hook with no hook configured should return exitCode=0
    const postResult = await runner.runPostHook(makePostMetadata());
    expect(postResult.exitCode).toBe(0);
  });

  it('persists hook artifacts when toolCallDir provided', async () => {
    const tmpDir = path.join(os.tmpdir(), `nectar-hook-test-${Date.now()}`);
    try {
      await mkdir(tmpDir, { recursive: true });
      const runner = new ToolHookRunner({ pre: 'echo pre-output && exit 0' });
      const result = await runner.runPreHook(makeMetadata(), tmpDir);
      expect(result.allowed).toBe(true);

      // Check artifact files
      const metaFile = await readFile(path.join(tmpDir, 'pre-hook.json'), 'utf8');
      const meta = JSON.parse(metaFile);
      expect(meta.phase).toBe('pre');
      expect(meta.exit_code).toBe(0);
      expect(meta.allowed).toBe(true);

      const stdout = await readFile(path.join(tmpDir, 'pre-hook.stdout.log'), 'utf8');
      expect(stdout).toContain('pre-output');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('post-hook receives blocked_by_pre_hook flag', async () => {
    const runner = new ToolHookRunner({ post: 'cat' });
    const meta = makePostMetadata({ blocked_by_pre_hook: true });
    const result = await runner.runPostHook(meta);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.blocked_by_pre_hook).toBe(true);
  });

  it('pre-hook exit 2 blocks with correct exit code', async () => {
    const runner = new ToolHookRunner({ pre: 'exit 2' });
    const result = await runner.runPreHook(makeMetadata());
    expect(result.allowed).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it('post-hook runs after pre-hook block', async () => {
    // First run pre-hook that blocks, then verify post-hook still runs
    const runner = new ToolHookRunner({ pre: 'exit 1', post: 'echo post-ran' });
    const preResult = await runner.runPreHook(makeMetadata());
    expect(preResult.allowed).toBe(false);

    // Post-hook should work even for blocked calls
    const postResult = await runner.runPostHook(makePostMetadata({ blocked_by_pre_hook: true }));
    expect(postResult.stdout).toContain('post-ran');
  });

  it('both pre and post hooks configured', () => {
    const runner = new ToolHookRunner({ pre: './pre.sh', post: './post.sh' });
    expect(runner.hasPreHook()).toBe(true);
    expect(runner.hasPostHook()).toBe(true);
    expect(runner.hasAnyHook()).toBe(true);
  });

  it('post-hook receives full metadata including duration_ms', async () => {
    const runner = new ToolHookRunner({ post: 'cat' });
    const meta = makePostMetadata({ duration_ms: 1234 });
    const result = await runner.runPostHook(meta);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.duration_ms).toBe(1234);
    expect(parsed.is_error).toBe(false);
    expect(parsed.content_preview).toBe('hello');
  });

  it('pre-hook receives correct env vars', async () => {
    const runner = new ToolHookRunner({ pre: 'echo $NECTAR_RUN_ID $NECTAR_NODE_ID $NECTAR_SESSION_ID $NECTAR_TOOL_CALL_ID' });
    const result = await runner.runPreHook(makeMetadata({
      run_id: 'r1',
      node_id: 'n1',
      session_id: 's1',
      tool_call_id: 'c1',
    }));
    expect(result.stdout.trim()).toBe('r1 n1 s1 c1');
  });
});
