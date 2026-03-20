import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { importAttachment, sanitizeFilename } from '../../src/seedbed/attachments.js';

let tmpDir: string;
let attachDir: string;

beforeEach(async () => {
  tmpDir = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'nectar-attach-')));
  attachDir = path.join(tmpDir, 'attachments');
  await mkdir(attachDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('sanitizeFilename', () => {
  it('lowercases and strips unsafe chars', () => {
    expect(sanitizeFilename('My File (1).PDF')).toBe('my-file-1.pdf');
  });

  it('preserves extension', () => {
    expect(sanitizeFilename('image.PNG')).toBe('image.png');
  });

  it('handles empty base', () => {
    expect(sanitizeFilename('!!!.txt')).toBe('attachment.txt');
  });

  it('handles names with multiple dots', () => {
    expect(sanitizeFilename('archive.tar.gz')).toBe('archive.tar.gz');
  });
});

describe('importAttachment', () => {
  it('copies a file to attachments dir', async () => {
    const src = path.join(tmpDir, 'test.txt');
    await writeFile(src, 'hello world');

    const result = await importAttachment(src, attachDir);
    expect(result.name).toBe('test.txt');
    expect(result.relativePath).toBe('attachments/test.txt');

    const contents = await readFile(path.join(attachDir, 'test.txt'), 'utf8');
    expect(contents).toBe('hello world');
  });

  it('sanitizes the filename', async () => {
    const src = path.join(tmpDir, 'My Report (Final).pdf');
    await writeFile(src, 'pdf content');

    const result = await importAttachment(src, attachDir);
    expect(result.name).toBe('my-report-final.pdf');
  });

  it('adds numeric suffix on collision', async () => {
    const src = path.join(tmpDir, 'test.txt');
    await writeFile(src, 'first');
    await writeFile(path.join(attachDir, 'test.txt'), 'existing');

    const result = await importAttachment(src, attachDir);
    expect(result.name).toBe('test-1.txt');

    const entries = await readdir(attachDir);
    expect(entries).toContain('test.txt');
    expect(entries).toContain('test-1.txt');
  });

  it('rejects files over 50 MB', async () => {
    const src = path.join(tmpDir, 'huge.bin');
    // Create a sparse file that reports 51 MB
    const fd = await import('node:fs/promises').then(fs => fs.open(src, 'w'));
    await fd.truncate(51 * 1024 * 1024);
    await fd.close();

    await expect(importAttachment(src, attachDir)).rejects.toThrow('exceeding the 50 MB limit');
  });
});
