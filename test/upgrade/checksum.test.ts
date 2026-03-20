import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChecksumFormatError,
  getChecksumForAsset,
  MissingChecksumError,
  parseChecksums,
  verifyChecksum
} from '../../src/upgrade/checksum.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempFile(contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-upgrade-checksum-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'binary');
  await writeFile(filePath, contents, 'utf8');
  return filePath;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('upgrade/checksum', () => {
  it('parses a valid SHA256SUMS file', () => {
    const one = 'a'.repeat(64);
    const two = 'b'.repeat(64);

    const parsed = parseChecksums(`${one}  nectar-linux-x64\n${two}  nectar-linux-arm64\n`);

    expect(parsed.get('nectar-linux-x64')).toBe(one);
    expect(parsed.get('nectar-linux-arm64')).toBe(two);
  });

  it('parses sha256sum binary-marker format', () => {
    const hash = 'c'.repeat(64);
    const parsed = parseChecksums(`${hash} *nectar-darwin-arm64\n`);
    expect(parsed.get('nectar-darwin-arm64')).toBe(hash);
  });

  it('throws when checksum file is empty', () => {
    expect(() => parseChecksums('\n\n')).toThrow(ChecksumFormatError);
  });

  it('throws on malformed checksum line', () => {
    expect(() => parseChecksums('not-a-valid-line\n')).toThrow(ChecksumFormatError);
  });

  it('throws on duplicate checksum entry', () => {
    const hash = 'd'.repeat(64);
    expect(() => parseChecksums(`${hash}  nectar-linux-x64\n${hash}  nectar-linux-x64\n`)).toThrow(ChecksumFormatError);
  });

  it('throws when asset is missing from checksum map', () => {
    const parsed = parseChecksums(`${'e'.repeat(64)}  nectar-linux-x64\n`);
    expect(() => getChecksumForAsset(parsed, 'nectar-linux-arm64')).toThrow(MissingChecksumError);
  });

  it('verifies checksum success', async () => {
    const content = 'fresh nectar';
    const filePath = await createTempFile(content);

    await expect(verifyChecksum(filePath, sha256(content))).resolves.toBe(true);
  });

  it('returns false on checksum mismatch', async () => {
    const content = 'fresh nectar';
    const filePath = await createTempFile(content);

    await expect(verifyChecksum(filePath, 'f'.repeat(64))).resolves.toBe(false);
  });

  it('throws for invalid expected hash format', async () => {
    const filePath = await createTempFile('nectar');
    await expect(verifyChecksum(filePath, '1234')).rejects.toThrow(ChecksumFormatError);
  });
});
