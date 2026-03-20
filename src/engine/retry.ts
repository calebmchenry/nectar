export const DEFAULT_RETRY_BASE_DELAY_MS = 200;
export const DEFAULT_RETRY_MULTIPLIER = 2;
export const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;

export function getRetryDelayMs(retryIndex: number, baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS): number {
  const base = baseDelayMs * Math.pow(DEFAULT_RETRY_MULTIPLIER, Math.max(0, retryIndex - 1));
  const jitter = 0.5 + Math.random();
  return Math.min(base * jitter, DEFAULT_RETRY_MAX_DELAY_MS);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
