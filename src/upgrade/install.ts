import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';

export class DownloadError extends Error {
  readonly status?: number;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'DownloadError';
    this.status = options?.status;
  }
}

export class PermissionDeniedError extends Error {
  readonly targetPath: string;

  constructor(targetPath: string, cause?: unknown) {
    super(`Permission denied writing to ${targetPath}`, { cause });
    this.name = 'PermissionDeniedError';
    this.targetPath = targetPath;
  }
}

export async function resolveBinaryPath(execPath = process.execPath): Promise<string> {
  return realpath(execPath);
}

export async function stageDownload(
  url: string,
  targetDir: string,
  options?: { fetchImpl?: typeof fetch; tempPrefix?: string }
): Promise<string> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const tempPrefix = options?.tempPrefix ?? '.nectar-upgrade';
  const tempPath = path.join(targetDir, `${tempPrefix}-${process.pid}-${randomUUID()}.tmp`);

  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new DownloadError(`Failed to download ${url}`, { cause: error });
  }

  if (!response.ok) {
    throw new DownloadError(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`, {
      status: response.status
    });
  }

  if (!response.body) {
    throw new DownloadError(`Download response from ${url} did not include a response body.`);
  }

  try {
    const body = response.body as WebReadableStream<Uint8Array>;
    await pipeline(Readable.fromWeb(body), createWriteStream(tempPath, { flags: 'wx', mode: 0o700 }));
    return tempPath;
  } catch (error) {
    await cleanupTempFile(tempPath);
    throw new DownloadError(`Failed while writing download to ${tempPath}`, { cause: error });
  }
}

export async function replaceBinary(tempPath: string, targetPath: string): Promise<void> {
  try {
    const targetStat = await stat(targetPath);
    await chmod(tempPath, targetStat.mode);
    await rename(tempPath, targetPath);
    await chmod(targetPath, targetStat.mode);
  } catch (error) {
    if (isPermissionError(error)) {
      throw new PermissionDeniedError(targetPath, error);
    }
    throw error;
  }
}

export async function cleanupTempFile(tempPath: string | null | undefined): Promise<void> {
  if (!tempPath) {
    return;
  }

  try {
    await unlink(tempPath);
  } catch (error) {
    if (isMissingFile(error)) {
      return;
    }
    throw error;
  }
}

function isPermissionError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

function isMissingFile(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === 'ENOENT';
}
