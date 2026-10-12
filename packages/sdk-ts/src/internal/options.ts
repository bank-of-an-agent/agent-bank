import type { RequestOptions } from "../client";

/** Transport options for a read inside a helper (no idempotency key). */
export function readOptions(options: RequestOptions): RequestOptions {
  const { signal, timeoutMs, maxRetries, headers } = options;
  return {
    ...(signal !== undefined ? { signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(headers !== undefined ? { headers } : {}),
  };
}

/**
 * Transport options for a write inside a helper. A caller-supplied
 * idempotency key is suffixed per step so that the several writes of one
 * helper never share a key (which the API would reject as a conflict).
 */
export function writeOptions(options: RequestOptions, step?: string): RequestOptions {
  const key = options.idempotencyKey;
  return {
    ...readOptions(options),
    ...(key !== undefined ? { idempotencyKey: step ? `${key}.${step}` : key } : {}),
  };
}
