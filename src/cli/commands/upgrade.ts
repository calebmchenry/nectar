import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import ora, { Ora } from 'ora';
import { Command } from 'commander';
import { NECTAR_VERSION } from '../../generated/version.js';
import { getChecksumForAsset, parseChecksums, verifyChecksum } from '../../upgrade/checksum.js';
import {
  fetchLatestRelease,
  MissingReleaseAssetError,
  NoReleasesError,
  ReleaseApiError,
  ReleaseNetworkError,
  type UpgradePlan
} from '../../upgrade/github.js';
import {
  cleanupTempFile,
  DownloadError,
  PermissionDeniedError,
  replaceBinary,
  resolveBinaryPath,
  stageDownload
} from '../../upgrade/install.js';
import { isCompiledBinary, resolvePlatformAsset, UnsupportedPlatformError } from '../../upgrade/platform.js';

interface UpgradeOptions {
  check: boolean;
  yes: boolean;
}

class ChecksumMismatchError extends Error {
  constructor() {
    super('Checksum verification failed.');
    this.name = 'ChecksumMismatchError';
  }
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Update Nectar from the latest GitHub release.')
    .option('--check', 'Check whether an update is available, without installing')
    .option('--yes', 'Skip confirmation prompt and install immediately')
    .action(async (options: UpgradeOptions) => {
      await runUpgrade(options);
    });
}

async function runUpgrade(options: UpgradeOptions): Promise<void> {
  const fancy = Boolean(process.stdout.isTTY);
  const writeOut = (fancyText: string, plainText: string) => {
    process.stdout.write(`${fancy ? fancyText : plainText}\n`);
  };
  const writeErr = (fancyText: string, plainText: string) => {
    process.stderr.write(`${fancy ? fancyText : plainText}\n`);
  };

  if (!isCompiledBinary()) {
    writeOut('🌱 Running from source — use git pull to update', 'Running from source - use git pull to update.');
    return;
  }

  let spinner: Ora | undefined;
  let tempPath: string | null = null;

  const signalHandlers = attachCleanupHandlers(async () => {
    await cleanupTempFile(tempPath);
  });

  try {
    writeOut('🐝 Checking the hive for updates...', 'Checking for updates...');

    const platform = resolvePlatformAsset();
    const binaryPath = await resolveBinaryPath();
    const apiBaseUrl = process.env.NECTAR_RELEASE_API_BASE_URL;
    const repository = process.env.NECTAR_RELEASE_REPOSITORY ?? 'calebmchenry/nectar';

    const plan = await fetchLatestRelease({
      currentVersion: NECTAR_VERSION,
      assetName: platform.assetName,
      binaryPath,
      apiBaseUrl,
      repository
    });

    if (plan.latestVersion === plan.currentVersion) {
      writeOut(
        `✅ Already on the latest nectar (v${plan.currentVersion})`,
        `Already on the latest nectar (v${plan.currentVersion}).`
      );
      return;
    }

    writeOut(
      `🍯 New nectar available! v${plan.currentVersion} → v${plan.latestVersion}`,
      `New version available: v${plan.currentVersion} -> v${plan.latestVersion}`
    );

    if (options.check) {
      return;
    }

    if (!options.yes) {
      const confirmed = await promptForConfirmation(plan);
      if (confirmed === null) {
        process.exitCode = 1;
        return;
      }
      if (!confirmed) {
        writeOut('Upgrade canceled.', 'Upgrade canceled.');
        return;
      }
    }

    const checksumsText = await downloadText(plan.checksumsUrl);
    const checksums = parseChecksums(checksumsText);
    const expectedChecksum = getChecksumForAsset(checksums, plan.assetName);

    if (fancy) {
      spinner = ora({ text: `⬇️  Downloading ${plan.assetName}...` }).start();
    } else {
      writeOut(`Downloading ${plan.assetName}...`, `Downloading ${plan.assetName}...`);
    }

    tempPath = await stageDownload(plan.downloadUrl, path.dirname(plan.binaryPath));

    if (spinner) {
      spinner.stop();
      spinner = undefined;
    }

    const isMatch = await verifyChecksum(tempPath, expectedChecksum);
    if (!isMatch) {
      throw new ChecksumMismatchError();
    }

    writeOut('✅ Verified checksum', 'Verified checksum.');

    await replaceBinary(tempPath, plan.binaryPath);
    tempPath = null;

    writeOut(
      `🌸 Upgraded! You're now on v${plan.latestVersion}`,
      `Upgraded successfully to v${plan.latestVersion}.`
    );
  } catch (error) {
    if (spinner) {
      spinner.stop();
    }
    handleUpgradeError(error, writeErr);
  } finally {
    detachCleanupHandlers(signalHandlers);
    await cleanupTempFile(tempPath);
  }
}

async function promptForConfirmation(plan: UpgradePlan): Promise<boolean | null> {
  if (!process.stdin.isTTY) {
    process.stderr.write('Non-interactive shell detected. Re-run with --yes to upgrade without a prompt.\n');
    return null;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr
  });

  try {
    const answer = (await rl.question(`Upgrade Nectar from v${plan.currentVersion} to v${plan.latestVersion}? [y/N] `))
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function downloadText(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new ReleaseNetworkError('Unable to download release metadata.', error);
  }

  if (!response.ok) {
    throw new ReleaseApiError(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`, {
      status: response.status
    });
  }

  return response.text();
}

function handleUpgradeError(
  error: unknown,
  writeErr: (fancyText: string, plainText: string) => void
): void {
  if (
    error instanceof ReleaseNetworkError ||
    (error instanceof DownloadError && isLikelyNetworkStatus(error.status)) ||
    isNetworkCause(error)
  ) {
    writeErr('🥀 Could not reach the hive — check your connection', 'Could not reach release servers. Check your connection.');
    process.exitCode = 1;
    return;
  }

  if (error instanceof NoReleasesError) {
    writeErr('🥀 No releases have been published yet.', 'No releases have been published yet.');
    return;
  }

  if (error instanceof UnsupportedPlatformError) {
    writeErr(`🥀 ${error.message}`, error.message);
    process.exitCode = 1;
    return;
  }

  if (error instanceof MissingReleaseAssetError) {
    writeErr(
      `🥀 Latest release is missing ${error.assetName} for this platform`,
      `Latest release is missing required asset: ${error.assetName}`
    );
    process.exitCode = 1;
    return;
  }

  if (error instanceof ChecksumMismatchError) {
    writeErr(
      '🥀 Checksum verification failed — download may be corrupted. Aborting.',
      'Checksum verification failed; download may be corrupted. Aborting.'
    );
    process.exitCode = 1;
    return;
  }

  if (error instanceof PermissionDeniedError || hasErrno(error, 'EACCES') || hasErrno(error, 'EPERM')) {
    const targetPath = error instanceof PermissionDeniedError
      ? error.targetPath
      : process.execPath;
    writeErr(
      `🥀 Permission denied writing to ${targetPath}. Try: sudo nectar upgrade`,
      `Permission denied writing to ${targetPath}. Try: sudo nectar upgrade`
    );
    process.exitCode = 1;
    return;
  }

  if (error instanceof ReleaseApiError || error instanceof DownloadError) {
    writeErr(`🥀 ${error.message}`, error.message);
    process.exitCode = 1;
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  writeErr(`🥀 ${message}`, message);
  process.exitCode = 1;
}

function hasErrno(error: unknown, code: string): boolean {
  return (error as { code?: string } | undefined)?.code === code;
}

function isLikelyNetworkStatus(status: number | undefined): boolean {
  return status === undefined || status >= 500;
}

function isNetworkCause(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (!cause || typeof cause !== 'object') {
    return false;
  }

  const code = (cause as { code?: string }).code;
  return code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET';
}

function attachCleanupHandlers(cleanup: () => Promise<void>): {
  onSigint: () => void;
  onSigterm: () => void;
} {
  const onSigint = () => {
    void cleanup().finally(() => {
      process.exitCode = 130;
      process.exit(130);
    });
  };

  const onSigterm = () => {
    void cleanup().finally(() => {
      process.exitCode = 143;
      process.exit(143);
    });
  };

  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  return { onSigint, onSigterm };
}

function detachCleanupHandlers(handlers: { onSigint: () => void; onSigterm: () => void }): void {
  process.off('SIGINT', handlers.onSigint);
  process.off('SIGTERM', handlers.onSigterm);
}
