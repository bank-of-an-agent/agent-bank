import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";

/**
 * Structured logging with pino. Secrets never reach the logs: credentials, signatures,
 * cookies, secrets and keys are redacted wherever they appear (top level and up to three
 * levels deep), including request and response headers.
 */

const SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "signature",
  "signature-input",
  "secret",
  "secret_hash",
  "secretHash",
  "shared_secret",
  "sharedSecret",
  "password",
  "token",
  "staff_token",
  "staffToken",
  "invite_token",
  "api_key",
  "apiKey",
  "private_key",
  "privateKey",
  "mnemonic",
  "seed",
  "session_signature",
  "owner_authorization",
  "webauthn_assertion",
  "x-api-key",
] as const;

function keyPath(prefix: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${prefix}.${key}` : `${prefix}["${key}"]`;
}

/** Every redaction path: each sensitive key at the top level and one to three levels deep. */
export const REDACT_PATHS: string[] = (() => {
  const paths = new Set<string>();
  for (const key of SENSITIVE_KEYS) {
    const top = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `["${key}"]`;
    paths.add(top);
    paths.add(keyPath("*", key));
    paths.add(keyPath("*.*", key));
    paths.add(keyPath("*.*.*", key));
  }
  for (const key of ["authorization", "cookie", "signature", "signature-input", "x-api-key"]) {
    paths.add(keyPath("req.headers", key));
    paths.add(keyPath("request.headers", key));
  }
  paths.add(keyPath("res.headers", "set-cookie"));
  return [...paths];
})();

export const REDACTED = "[redacted]";

export function loggerOptions(level: LoggerOptions["level"]): LoggerOptions {
  return {
    level,
    base: { service: "api" },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
}

export function createLogger(
  level: LoggerOptions["level"] = "info",
  destination?: DestinationStream,
): Logger {
  const options = loggerOptions(level);
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
