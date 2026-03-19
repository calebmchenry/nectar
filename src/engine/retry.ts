export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
export const DEFAULT_RETRY_MULTIPLIER = 2;

export function getRetryDelayMs(retryIndex: number, baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS): number {
  return baseDelayMs * Math.pow(DEFAULT_RETRY_MULTIPLIER, Math.max(0, retryIndex - 1));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
