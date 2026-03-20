import path from 'node:path';

export type SupportedOS = 'darwin' | 'linux';
export type SupportedArch = 'arm64' | 'x64';

export interface SupportedPlatform {
  os: SupportedOS;
  arch: SupportedArch;
  assetName: string;
}

export interface RuntimeFingerprint {
  release?: { name?: string | undefined };
  versions?: Record<string, string | undefined>;
  execPath?: string;
}

export class UnsupportedPlatformError extends Error {
  readonly platform: string;
  readonly arch: string;

  constructor(platform: string, arch: string) {
    super(
      `Unsupported platform '${platform}/${arch}'. Supported release targets: darwin/arm64, darwin/x64, linux/arm64, linux/x64.`
    );
    this.name = 'UnsupportedPlatformError';
    this.platform = platform;
    this.arch = arch;
  }
}

export function resolvePlatformAsset(platform = process.platform, arch = process.arch): SupportedPlatform {
  const os = normalizeOS(platform);
  const normalizedArch = normalizeArch(arch);

  if (!os || !normalizedArch) {
    throw new UnsupportedPlatformError(platform, arch);
  }

  return {
    os,
    arch: normalizedArch,
    assetName: `nectar-${os}-${normalizedArch}`
  };
}

export function isCompiledBinary(runtime: RuntimeFingerprint = process): boolean {
  // Bun sets process.release.name to 'node' for compatibility, so we check
  // process.versions.bun instead to detect the Bun runtime.
  const bunVersion = runtime.versions?.bun;
  if (!bunVersion) {
    return false;
  }

  const binaryName = path.basename(runtime.execPath ?? '').toLowerCase();
  if (!binaryName) {
    return false;
  }

  return !new Set(['bun', 'bun.exe', 'bunx', 'bunx.exe', 'node', 'node.exe', 'tsx']).has(binaryName);
}

function normalizeOS(platform: string): SupportedOS | undefined {
  if (platform === 'darwin' || platform === 'linux') {
    return platform;
  }
  return undefined;
}

function normalizeArch(arch: string): SupportedArch | undefined {
  if (arch === 'arm64' || arch === 'x64') {
    return arch;
  }
  return undefined;
}
