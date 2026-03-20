import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const SHA256_LINE = /^([a-fA-F0-9]{64})\s+\*?(.+)$/;
const SHA256_HEX = /^[a-fA-F0-9]{64}$/;

export class ChecksumFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChecksumFormatError';
  }
}

export class MissingChecksumError extends Error {
  readonly assetName: string;

  constructor(assetName: string) {
    super(`SHA256SUMS does not contain an entry for ${assetName}`);
    this.name = 'MissingChecksumError';
    this.assetName = assetName;
  }
}

export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const match = line.match(SHA256_LINE);
    if (!match) {
      throw new ChecksumFormatError(`Malformed SHA256SUMS line: ${rawLine}`);
    }

    const hash = match[1]!.toLowerCase();
    const assetName = match[2]!.trim();

    if (!assetName) {
      throw new ChecksumFormatError(`Malformed SHA256SUMS line: ${rawLine}`);
    }

    if (map.has(assetName)) {
      throw new ChecksumFormatError(`Duplicate checksum entry for ${assetName}`);
    }

    map.set(assetName, hash);
  }

  if (map.size === 0) {
    throw new ChecksumFormatError('SHA256SUMS is empty.');
  }

  return map;
}

export function getChecksumForAsset(checksums: Map<string, string>, assetName: string): string {
  const hash = checksums.get(assetName);
  if (!hash) {
    throw new MissingChecksumError(assetName);
  }
  return hash;
}

export async function verifyChecksum(filePath: string, expectedHash: string): Promise<boolean> {
  const normalizedExpected = expectedHash.trim().toLowerCase();
  if (!SHA256_HEX.test(normalizedExpected)) {
    throw new ChecksumFormatError(`Expected checksum is not a valid SHA256 hex digest: ${expectedHash}`);
  }

  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }

  return hash.digest('hex') === normalizedExpected;
}
