import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePatchV4A, applyParsedPatch, PatchParseError } from '../../src/agent-loop/patch.js';
import { LocalExecutionEnvironment } from '../../src/agent-loop/execution-environment.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-patch-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('parsePatchV4A', () => {
  it('parses a single-file update with context', () => {
    const patch = `*** Begin Patch
*** Update File: src/config.ts
@@
 const MAX_RETRIES = 3;
-const TIMEOUT = 1000;
+const TIMEOUT = 5000;
 const DEBUG = false;
*** End Patch`;

    const ops = parsePatchV4A(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe('update');
    expect(ops[0]!.path).toBe('src/config.ts');
    expect(ops[0]!.hunks).toHaveLength(1);
    expect(ops[0]!.hunks[0]!.context_before).toEqual(['const MAX_RETRIES = 3;']);
    expect(ops[0]!.hunks[0]!.remove_lines).toEqual(['const TIMEOUT = 1000;']);
    expect(ops[0]!.hunks[0]!.add_lines).toEqual(['const TIMEOUT = 5000;']);
    expect(ops[0]!.hunks[0]!.context_after).toEqual(['const DEBUG = false;']);
  });

  it('parses add file', () => {
    const patch = `*** Begin Patch
*** Add File: src/new.ts
export const greeting = "hello";
*** End Patch`;

    const ops = parsePatchV4A(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe('add');
    expect(ops[0]!.path).toBe('src/new.ts');
    expect(ops[0]!.new_content).toBe('export const greeting = "hello";');
  });

  it('parses delete file', () => {
    const patch = `*** Begin Patch
*** Delete File: src/old.ts
*** End Patch`;

    const ops = parsePatchV4A(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe('delete');
    expect(ops[0]!.path).toBe('src/old.ts');
  });

  it('parses move (update with move_to)', () => {
    const patch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
 const x = 1;
-const y = 2;
+const y = 3;
*** End Patch`;

    const ops = parsePatchV4A(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe('move');
    expect(ops[0]!.path).toBe('src/old.ts');
    expect(ops[0]!.move_to).toBe('src/new.ts');
  });

  it('parses multi-file patch', () => {
    const patch = `*** Begin Patch
*** Add File: src/a.ts
content a
*** Update File: src/b.ts
@@
-old
+new
*** Delete File: src/c.ts
*** End Patch`;

    const ops = parsePatchV4A(patch);
    expect(ops).toHaveLength(3);
    expect(ops[0]!.type).toBe('add');
    expect(ops[1]!.type).toBe('update');
    expect(ops[2]!.type).toBe('delete');
  });

  it('rejects empty patch', () => {
    expect(() => parsePatchV4A('')).toThrow(PatchParseError);
    expect(() => parsePatchV4A('  ')).toThrow(PatchParseError);
  });

  it('rejects missing Begin Patch', () => {
    expect(() => parsePatchV4A('*** End Patch')).toThrow('Missing "*** Begin Patch"');
  });

  it('rejects missing End Patch', () => {
    expect(() => parsePatchV4A('*** Begin Patch\n*** Add File: a.ts\ncontent')).toThrow('Missing "*** End Patch"');
  });

  it('rejects malformed input', () => {
    expect(() => parsePatchV4A('*** Begin Patch\nrandom garbage here\n*** End Patch')).toThrow();
  });

  it('handles mixed line endings (CRLF input)', () => {
    const patch = '*** Begin Patch\r\n*** Add File: src/new.ts\r\ncontent\r\n*** End Patch';
    const ops = parsePatchV4A(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe('add');
  });
});

describe('applyParsedPatch', () => {
  it('applies a single-file update', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'config.ts'), 'const MAX_RETRIES = 3;\nconst TIMEOUT = 1000;\nconst DEBUG = false;\n', 'utf8');

    const env = new LocalExecutionEnvironment(workspace);
    const ops = parsePatchV4A(`*** Begin Patch
*** Update File: config.ts
@@
 const MAX_RETRIES = 3;
-const TIMEOUT = 1000;
+const TIMEOUT = 5000;
 const DEBUG = false;
*** End Patch`);

    const result = await applyParsedPatch(ops, env);
    expect(result.success).toBe(true);
    expect(result.files_modified).toBe(1);

    const content = await readFile(path.join(workspace, 'config.ts'), 'utf8');
    expect(content).toContain('const TIMEOUT = 5000;');
    expect(content).not.toContain('const TIMEOUT = 1000;');
  });

  it('adds a new file', async () => {
    const workspace = await createWorkspace();
    const env = new LocalExecutionEnvironment(workspace);
    const ops = parsePatchV4A(`*** Begin Patch
*** Add File: src/greeting.ts
export const hello = "world";
*** End Patch`);

    const result = await applyParsedPatch(ops, env);
    expect(result.success).toBe(true);
    expect(result.files_added).toBe(1);

    const content = await readFile(path.join(workspace, 'src', 'greeting.ts'), 'utf8');
    expect(content).toBe('export const hello = "world";');
  });

  it('rejects add when file already exists', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'exists.ts'), 'old content', 'utf8');

    const env = new LocalExecutionEnvironment(workspace);
    const ops = parsePatchV4A(`*** Begin Patch
*** Add File: exists.ts
new content
*** End Patch`);

    const result = await applyParsedPatch(ops, env);
    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('deletes an existing file', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'to-delete.ts'), 'content', 'utf8');

    const env = new LocalExecutionEnvironment(workspace);
    const ops = parsePatchV4A(`*** Begin Patch
*** Delete File: to-delete.ts
*** End Patch`);

    const result = await applyParsedPatch(ops, env);
    expect(result.success).toBe(true);
    expect(result.files_deleted).toBe(1);

    const exists = await env.fileExists('to-delete.ts');
    expect(exists).toBe(false);
  });

  it('moves/renames a file', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'old-name.ts'), 'const x = 1;\nconst y = 2;\n', 'utf8');

    const env = new LocalExecutionEnvironment(workspace);
    const ops = parsePatchV4A(`*** Begin Patch
*** Update File: old-name.ts
*** Move to: new-name.ts
@@
 const x = 1;
-const y = 2;
+const y = 3;
*** End Patch`);

    const result = await applyParsedPatch(ops, env);
    expect(result.success).toBe(true);
    expect(result.files_modified).toBe(1);

    const newContent = await readFile(path.join(workspace, 'new-name.ts'), 'utf8');
    expect(newContent).toContain('const y = 3;');
    const oldExists = await env.fileExists('old-name.ts');
    expect(oldExists).toBe(false);
  });

  it('applies multi-file patch atomically', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'a.ts'), 'const a = 1;\n', 'utf8');
    await writeFile(path.join(workspace, 'b.ts'), 'content b', 'utf8');

    const env = new LocalExecutionEnvironment(workspace);
    const ops = parsePatchV4A(`*** Begin Patch
*** Add File: c.ts
new file
*** Update File: a.ts
@@
-const a = 1;
+const a = 2;
*** Delete File: b.ts
*** End Patch`);

    const result = await applyParsedPatch(ops, env);
    expect(result.success).toBe(true);
    expect(result.files_added).toBe(1);
    expect(result.files_modified).toBe(1);
    expect(result.files_deleted).toBe(1);
  });

  it('fails atomically on context mismatch', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'file.ts'), 'line 1\nline 2\nline 3\n', 'utf8');

    const env = new LocalExecutionEnvironment(workspace);
    const ops = parsePatchV4A(`*** Begin Patch
*** Update File: file.ts
@@
 wrong context
-line 2
+line 2b
*** End Patch`);

    const result = await applyParsedPatch(ops, env);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Context lines do not match');
    expect(result.files_modified).toBe(0);

    // Verify file unchanged
    const content = await readFile(path.join(workspace, 'file.ts'), 'utf8');
    expect(content).toBe('line 1\nline 2\nline 3\n');
  });

  it('rejects path traversal', async () => {
    const workspace = await createWorkspace();
    const env = new LocalExecutionEnvironment(workspace);
    const ops = parsePatchV4A(`*** Begin Patch
*** Add File: ../../etc/passwd
evil content
*** End Patch`);

    const result = await applyParsedPatch(ops, env);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Path traversal');
  });

  it('handles CRLF file with LF patch input', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, 'crlf.ts'), 'line 1\r\nold line\r\nline 3\r\n', 'utf8');

    const env = new LocalExecutionEnvironment(workspace);
    const ops = parsePatchV4A(`*** Begin Patch
*** Update File: crlf.ts
@@
 line 1
-old line
+new line
 line 3
*** End Patch`);

    const result = await applyParsedPatch(ops, env);
    expect(result.success).toBe(true);

    const content = await readFile(path.join(workspace, 'crlf.ts'), 'utf8');
    expect(content).toContain('\r\n');
    expect(content).toContain('new line');
  });
});
