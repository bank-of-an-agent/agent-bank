/** Retry policy: exponential backoff with jitter, honoring `Retry-After`. */
export interface RetryOptions {
  /** Retries after the first attempt (default 2, so at most 3 attempts). */
  maxRetries?: number;
  /** First backoff step in milliseconds (default 500). */
  baseDelayMs?: number;
  /** Cap for a single backoff step in milliseconds (default 8000). */
  maxDelayMs?: number;
  /**
   * Longest `Retry-After` the client will wait for, in milliseconds (default
   * 60000). A longer server-requested delay fails fast with the error instead
   * of blocking the caller.
   */
  maxRetryAfterMs?: number;
}

/** Default retry policy: 2 retries, 500 ms base, 8 s cap, honor `Retry-After` up to 60 s. */
export const DEFAULT_RETRY: Required<RetryOptions> = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 60_000,
};

/**
 * Backoff for retry number `attempt` (0-based) with "equal jitter": half the
 * exponential step plus a random share of the other half, so concurrent
 * clients spread out but never retry immediately.
 */
export function backoffDelay(
  attempt: number,
  options: Pick<Required<RetryOptions>, "baseDelayMs" | "maxDelayMs">,
  random: () => number = Math.random,
): number {
  const step = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  return Math.round(step / 2 + random() * (step / 2));
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^[0-9]+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Sleep for `ms`, rejecting early with the signal's reason if it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
