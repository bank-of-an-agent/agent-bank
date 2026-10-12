import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** SHA-256 of a UTF-8 string, lowercase hex (no 0x). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A random URL-safe token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time string equality (compares SHA-256 digests so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/** Prefix of every API key secret. Agent Bank is testnet-only, so every key is a test key. */
export const API_KEY_PREFIX = "abk_test_";

export function newApiKeySecret(): string {
  return `${API_KEY_PREFIX}${randomToken(32)}`;
}

/** Display prefix stored with the key (never enough to authenticate). */
export function apiKeyDisplayPrefix(secret: string): string {
  return secret.slice(0, API_KEY_PREFIX.length + 4);
}

export function newWebhookSecret(): string {
  return `whsec_${randomToken(32)}`;
}
