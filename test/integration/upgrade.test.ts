import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProgram } from '../../src/cli/index.js';
import { NECTAR_VERSION } from '../../src/generated/version.js';
import { resolvePlatformAsset } from '../../src/upgrade/platform.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function captureOutput() {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  (process.stdout.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;

  (process.stderr.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stderr.write;

  return {
    restore() {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    },
    stdout() {
      return stdoutChunks.join('');
    },
    stderr() {
      return stderrChunks.join('');
    }
  };
}

function patchCompiledRuntime(fakeExecPath: string): () => void {
  const releaseDescriptor = Object.getOwnPropertyDescriptor(process, 'release');
  const versionsDescriptor = Object.getOwnPropertyDescriptor(process, 'versions');
  const originalExecPath = process.execPath;
  const originalStdoutIsTTY = process.stdout.isTTY;
  const originalStdinIsTTY = process.stdin.isTTY;

  Object.defineProperty(process, 'release', {
    configurable: true,
    value: { ...(process.release ?? {}), name: 'bun' }
  });

  Object.defineProperty(process, 'versions', {
    configurable: true,
    value: { ...process.versions, bun: process.versions.bun ?? '1.2.0' }
  });

  process.execPath = fakeExecPath;

  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: false
  });

  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: false
  });

  return () => {
    process.execPath = originalExecPath;

    if (releaseDescriptor) {
      Object.defineProperty(process, 'release', releaseDescriptor);
    }
    if (versionsDescriptor) {
      Object.defineProperty(process, 'versions', versionsDescriptor);
    }

    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalStdoutIsTTY
    });

    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: originalStdinIsTTY
    });
  };
}

interface FakeReleaseServerOptions {
  assetName: string;
  latestVersion: string;
  binaryContent?: Buffer;
  releaseStatus?: number;
  includePlatformAsset?: boolean;
  includeChecksums?: boolean;
  checksumOverride?: string;
}

async function startFakeReleaseServer(options: FakeReleaseServerOptions): Promise<{
  apiBaseUrl: string;
  close: () => Promise<void>;
}> {
  const binaryContent = options.binaryContent ?? Buffer.from('#!/bin/sh\necho upgraded\n', 'utf8');
  const expectedChecksum = options.checksumOverride ?? sha256(binaryContent);
  const includePlatformAsset = options.includePlatformAsset ?? true;
  const includeChecksums = options.includeChecksums ?? true;
  const releaseStatus = options.releaseStatus ?? 200;

  const server = createServer((req, res) => {
    handleRequest(req, res, {
      assetName: options.assetName,
      latestVersion: options.latestVersion,
      binaryContent,
      expectedChecksum,
      includePlatformAsset,
      includeChecksums,
      releaseStatus
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind fake release server');
  }

  return {
    apiBaseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  };
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    assetName: string;
    latestVersion: string;
    binaryContent: Buffer;
    expectedChecksum: string;
    includePlatformAsset: boolean;
    includeChecksums: boolean;
    releaseStatus: number;
  }
): void {
  const url = req.url ?? '/';
  const host = req.headers.host ?? '127.0.0.1';
  const baseUrl = `http://${host}`;

  if (url === '/repos/calebmchenry/nectar/releases/latest') {
    if (options.releaseStatus !== 200) {
      res.writeHead(options.releaseStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'not found' }));
      return;
    }

    const assets: Array<{ name: string; browser_download_url: string }> = [];
    if (options.includePlatformAsset) {
      assets.push({
        name: options.assetName,
        browser_download_url: `${baseUrl}/download/${options.assetName}`
      });
    }

    if (options.includeChecksums) {
      assets.push({
        name: 'SHA256SUMS',
        browser_download_url: `${baseUrl}/download/SHA256SUMS`
      });
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        tag_name: `v${options.latestVersion}`,
        assets
      })
    );
    return;
  }

  if (url === `/download/${options.assetName}`) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(options.binaryContent);
    return;
  }

  if (url === '/download/SHA256SUMS') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${options.expectedChecksum}  ${options.assetName}\n`);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message: 'not found' }));
}

async function setupFakeBinary(contents = '#!/bin/sh\necho old\n'): Promise<{ dir: string; binaryPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nectar-upgrade-int-'));
  tempDirs.push(dir);

  const binaryPath = path.join(dir, 'nectar');
  await writeFile(binaryPath, contents, 'utf8');
  await chmod(binaryPath, 0o755);

  return { dir, binaryPath };
}

async function runUpgrade(args: string[], envOverrides: Record<string, string | undefined>) {
  const oldExitCode = process.exitCode;
  const oldEnv: Record<string, string | undefined> = {
    NECTAR_RELEASE_API_BASE_URL: process.env.NECTAR_RELEASE_API_BASE_URL,
    NECTAR_RELEASE_REPOSITORY: process.env.NECTAR_RELEASE_REPOSITORY
  };

  process.exitCode = 0;

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const capture = captureOutput();

  try {
    await createProgram().parseAsync(['upgrade', ...args], { from: 'user' });
  } finally {
    capture.restore();

    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = oldExitCode;

  return {
    exitCode,
    stdout: capture.stdout(),
    stderr: capture.stderr()
  };
}

describe('integration upgrade command', () => {
  it('running from source prints guidance and skips updates', async () => {
    const { binaryPath } = await setupFakeBinary();
    const before = await readFile(binaryPath, 'utf8');

    const result = await runUpgrade(['--check'], {
      NECTAR_RELEASE_API_BASE_URL: 'http://127.0.0.1:9'
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Running from source - use git pull to update');
    expect(await readFile(binaryPath, 'utf8')).toBe(before);
  });

  it('--check reports available version without modifying binary', async () => {
    const platform = resolvePlatformAsset();
    const { binaryPath } = await setupFakeBinary();
    const before = await readFile(binaryPath, 'utf8');

    const server = await startFakeReleaseServer({
      assetName: platform.assetName,
      latestVersion: '9.9.9'
    });

    const restoreRuntime = patchCompiledRuntime(binaryPath);

    try {
      const result = await runUpgrade(['--check'], {
        NECTAR_RELEASE_API_BASE_URL: server.apiBaseUrl
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Checking for updates');
      expect(result.stdout).toContain(`New version available: v${NECTAR_VERSION} -> v9.9.9`);

      const after = await readFile(binaryPath, 'utf8');
      expect(after).toBe(before);
    } finally {
      restoreRuntime();
      await server.close();
    }
  });

  it('--check reports already up to date when versions match', async () => {
    const platform = resolvePlatformAsset();
    const { binaryPath } = await setupFakeBinary();

    const server = await startFakeReleaseServer({
      assetName: platform.assetName,
      latestVersion: NECTAR_VERSION
    });

    const restoreRuntime = patchCompiledRuntime(binaryPath);

    try {
      const result = await runUpgrade(['--check'], {
        NECTAR_RELEASE_API_BASE_URL: server.apiBaseUrl
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Already on the latest nectar (v${NECTAR_VERSION})`);
    } finally {
      restoreRuntime();
      await server.close();
    }
  });

  it('--yes replaces binary contents and preserves permissions', async () => {
    const platform = resolvePlatformAsset();
    const { dir, binaryPath } = await setupFakeBinary('#!/bin/sh\necho before\n');
    const beforeMode = (await stat(binaryPath)).mode & 0o777;

    const updatedBinary = Buffer.from('#!/bin/sh\necho after\n', 'utf8');
    const server = await startFakeReleaseServer({
      assetName: platform.assetName,
      latestVersion: '1.2.3',
      binaryContent: updatedBinary
    });

    const restoreRuntime = patchCompiledRuntime(binaryPath);

    try {
      const result = await runUpgrade(['--yes'], {
        NECTAR_RELEASE_API_BASE_URL: server.apiBaseUrl
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Verified checksum');
      expect(result.stdout).toContain('Upgraded successfully to v1.2.3');
      expect(await readFile(binaryPath, 'utf8')).toBe(updatedBinary.toString('utf8'));
      expect((await stat(binaryPath)).mode & 0o777).toBe(beforeMode);

      const leftovers = (await readdir(dir)).filter((name) => name.startsWith('.nectar-upgrade-'));
      expect(leftovers).toHaveLength(0);
    } finally {
      restoreRuntime();
      await server.close();
    }
  });

  it('checksum mismatch aborts before replacement', async () => {
    const platform = resolvePlatformAsset();
    const { dir, binaryPath } = await setupFakeBinary('#!/bin/sh\necho original\n');
    const before = await readFile(binaryPath, 'utf8');

    const server = await startFakeReleaseServer({
      assetName: platform.assetName,
      latestVersion: '2.0.0',
      binaryContent: Buffer.from('#!/bin/sh\necho corrupted\n', 'utf8'),
      checksumOverride: '0'.repeat(64)
    });

    const restoreRuntime = patchCompiledRuntime(binaryPath);

    try {
      const result = await runUpgrade(['--yes'], {
        NECTAR_RELEASE_API_BASE_URL: server.apiBaseUrl
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Checksum verification failed');
      expect(await readFile(binaryPath, 'utf8')).toBe(before);

      const leftovers = (await readdir(dir)).filter((name) => name.startsWith('.nectar-upgrade-'));
      expect(leftovers).toHaveLength(0);
    } finally {
      restoreRuntime();
      await server.close();
    }
  });

  it('network failures surface clean error', async () => {
    const { binaryPath } = await setupFakeBinary();
    const restoreRuntime = patchCompiledRuntime(binaryPath);

    try {
      const result = await runUpgrade(['--check'], {
        NECTAR_RELEASE_API_BASE_URL: 'http://127.0.0.1:9'
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Could not reach release servers');
    } finally {
      restoreRuntime();
    }
  });

  it('handles no-release 404 with clear message', async () => {
    const platform = resolvePlatformAsset();
    const { binaryPath } = await setupFakeBinary();

    const server = await startFakeReleaseServer({
      assetName: platform.assetName,
      latestVersion: '0.0.0',
      releaseStatus: 404
    });

    const restoreRuntime = patchCompiledRuntime(binaryPath);

    try {
      const result = await runUpgrade(['--check'], {
        NECTAR_RELEASE_API_BASE_URL: server.apiBaseUrl
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('No releases have been published yet');
    } finally {
      restoreRuntime();
      await server.close();
    }
  });

  it('reports missing platform asset in release metadata', async () => {
    const platform = resolvePlatformAsset();
    const { binaryPath } = await setupFakeBinary();

    const server = await startFakeReleaseServer({
      assetName: platform.assetName,
      latestVersion: '5.0.0',
      includePlatformAsset: false,
      includeChecksums: true
    });

    const restoreRuntime = patchCompiledRuntime(binaryPath);

    try {
      const result = await runUpgrade(['--check'], {
        NECTAR_RELEASE_API_BASE_URL: server.apiBaseUrl
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Latest release is missing required asset');
      expect(result.stderr).toContain(platform.assetName);
    } finally {
      restoreRuntime();
      await server.close();
    }
  });
});
