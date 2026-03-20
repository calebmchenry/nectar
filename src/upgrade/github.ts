export interface UpgradePlan {
  currentVersion: string;
  latestVersion: string;
  assetName: string;
  binaryPath: string;
  downloadUrl: string;
  checksumsUrl: string;
}

export interface FetchLatestReleaseOptions {
  currentVersion: string;
  assetName: string;
  binaryPath: string;
  repository?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface ParsedRelease {
  tagName: string;
  assets: ReleaseAsset[];
}

export class ReleaseNetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ReleaseNetworkError';
  }
}

export class ReleaseApiError extends Error {
  readonly status?: number;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'ReleaseApiError';
    this.status = options?.status;
  }
}

export class NoReleasesError extends Error {
  constructor() {
    super('No releases found yet for calebmchenry/nectar.');
    this.name = 'NoReleasesError';
  }
}

export class MissingReleaseAssetError extends Error {
  readonly assetName: string;

  constructor(assetName: string) {
    super(`Latest release is missing required asset: ${assetName}`);
    this.name = 'MissingReleaseAssetError';
    this.assetName = assetName;
  }
}

export async function fetchLatestRelease(options: FetchLatestReleaseOptions): Promise<UpgradePlan> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const repository = options.repository ?? 'calebmchenry/nectar';
  const apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';

  const releaseUrl = new URL(`/repos/${repository}/releases/latest`, withTrailingSlash(apiBaseUrl));

  let response: Response;
  try {
    response = await fetchImpl(releaseUrl, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'nectar-upgrade'
      }
    });
  } catch (error) {
    throw new ReleaseNetworkError('Unable to reach GitHub Releases API.', error);
  }

  if (response.status === 404) {
    throw new NoReleasesError();
  }

  if (!response.ok) {
    throw new ReleaseApiError(
      `GitHub Releases API request failed with ${response.status} ${response.statusText}`,
      { status: response.status }
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ReleaseApiError('GitHub Releases API returned invalid JSON.', {
      status: response.status,
      cause: error
    });
  }

  const release = parseRelease(payload);
  if (release.assets.length === 0) {
    throw new ReleaseApiError('Latest release does not contain any assets.');
  }

  const platformAsset = release.assets.find((asset) => asset.name === options.assetName);
  if (!platformAsset) {
    throw new MissingReleaseAssetError(options.assetName);
  }

  const checksumsAsset = release.assets.find((asset) => asset.name === 'SHA256SUMS');
  if (!checksumsAsset) {
    throw new MissingReleaseAssetError('SHA256SUMS');
  }

  return {
    currentVersion: options.currentVersion,
    latestVersion: stripVersionPrefix(release.tagName),
    assetName: options.assetName,
    binaryPath: options.binaryPath,
    downloadUrl: platformAsset.browser_download_url,
    checksumsUrl: checksumsAsset.browser_download_url
  };
}

function parseRelease(payload: unknown): ParsedRelease {
  if (!payload || typeof payload !== 'object') {
    throw new ReleaseApiError('GitHub Releases API payload is not an object.');
  }

  const obj = payload as Record<string, unknown>;
  const tagName = obj['tag_name'];
  const assetsRaw = obj['assets'];

  if (typeof tagName !== 'string' || !tagName.trim()) {
    throw new ReleaseApiError('Latest release payload is missing tag_name.');
  }

  if (!Array.isArray(assetsRaw)) {
    throw new ReleaseApiError('Latest release payload is missing assets array.');
  }

  const assets: ReleaseAsset[] = assetsRaw.map((assetRaw, index) => {
    if (!assetRaw || typeof assetRaw !== 'object') {
      throw new ReleaseApiError(`Asset at index ${index} is malformed.`);
    }

    const asset = assetRaw as Record<string, unknown>;
    const name = asset['name'];
    const browserDownloadUrl = asset['browser_download_url'];

    if (typeof name !== 'string' || !name.trim()) {
      throw new ReleaseApiError(`Asset at index ${index} is missing name.`);
    }
    if (typeof browserDownloadUrl !== 'string' || !browserDownloadUrl.trim()) {
      throw new ReleaseApiError(`Asset '${name}' is missing browser_download_url.`);
    }

    return {
      name,
      browser_download_url: browserDownloadUrl
    };
  });

  return {
    tagName,
    assets
  };
}

function stripVersionPrefix(tag: string): string {
  return tag.replace(/^v/, '');
}

function withTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
