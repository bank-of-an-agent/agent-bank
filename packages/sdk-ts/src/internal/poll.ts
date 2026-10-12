import { sleep } from "./retry";

/** Options for waiting on a resource to change state. */
export interface WaitOptions {
  /** Give up after this many milliseconds (default 60000). */
  timeoutMs?: number;
  /** First polling interval in milliseconds (default 1000); grows ×1.5 up to 5000. */
  intervalMs?: number;
  /** Abort the wait. */
  signal?: AbortSignal;
}

/**
 * Poll `load` until `done(value)` or the timeout. Returns the last value
 * either way: reaching the timeout is not an error, callers inspect the status.
 */
export async function pollUntil<T>(
  load: () => Promise<T>,
  done: (value: T) => boolean,
  options: WaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let interval = options.intervalMs ?? 1_000;
  let value = await load();
  while (!done(value)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(interval, remaining), options.signal);
    interval = Math.min(Math.round(interval * 1.5), 5_000);
    value = await load();
  }
  return value;
}
