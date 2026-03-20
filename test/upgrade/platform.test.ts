import { describe, expect, it } from 'vitest';
import { isCompiledBinary, resolvePlatformAsset, UnsupportedPlatformError } from '../../src/upgrade/platform.js';

describe('upgrade/platform', () => {
  it('maps darwin arm64 to release asset', () => {
    expect(resolvePlatformAsset('darwin', 'arm64')).toEqual({
      os: 'darwin',
      arch: 'arm64',
      assetName: 'nectar-darwin-arm64'
    });
  });

  it('maps darwin x64 to release asset', () => {
    expect(resolvePlatformAsset('darwin', 'x64').assetName).toBe('nectar-darwin-x64');
  });

  it('maps linux x64 to release asset', () => {
    expect(resolvePlatformAsset('linux', 'x64').assetName).toBe('nectar-linux-x64');
  });

  it('maps linux arm64 to release asset', () => {
    expect(resolvePlatformAsset('linux', 'arm64').assetName).toBe('nectar-linux-arm64');
  });

  it('throws on unsupported operating system', () => {
    expect(() => resolvePlatformAsset('win32', 'x64')).toThrow(UnsupportedPlatformError);
  });

  it('throws on unsupported architecture', () => {
    expect(() => resolvePlatformAsset('linux', 'ppc64')).toThrow(UnsupportedPlatformError);
  });

  it('detects source execution in node runtime', () => {
    expect(
      isCompiledBinary({
        release: { name: 'node' },
        versions: { node: '22.10.0' },
        execPath: '/usr/local/bin/node'
      })
    ).toBe(false);
  });

  it('detects source execution in bun runtime', () => {
    expect(
      isCompiledBinary({
        release: { name: 'node' },
        versions: { bun: '1.2.0' },
        execPath: '/usr/local/bin/bun'
      })
    ).toBe(false);
  });

  it('detects compiled bun binary runtime', () => {
    // Bun sets process.release.name to 'node' for compatibility
    expect(
      isCompiledBinary({
        release: { name: 'node' },
        versions: { bun: '1.2.0' },
        execPath: '/Users/caleb/.local/bin/nectar'
      })
    ).toBe(true);
  });
});
