import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";

/**
 * Structured logging with pino. Secrets never reach the logs: the relayer key, signatures
 * (an EIP-3009 signature is a bearer authorization until it settles or expires), credentials
 * and keys are redacted wherever they appear (top level and up to three levels deep), and the
 * facilitator only ever logs selected fields of a payment, never the payload itself.
 */

const SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "signature",
  "signatures",
  "secret",
  "password",
  "token",
  "api_key",
  "apiKey",
  "private_key",
  "privateKey",
  "relayerKey",
  "relayer_key",
  "FACILITATOR_RELAYER_KEY",
  "SCREENING_API_KEY",
  "DATABASE_URL",
  "databaseUrl",
  "mnemonic",
  "seed",
  "x-api-key",
] as const;

function keyPath(prefix: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${prefix}.${key}` : `${prefix}["${key}"]`;
}

/** Every redaction path: each sensitive key at the top level and one to three levels deep. */
export const REDACT_PATHS: string[] = (() => {
  const paths = new Set<string>();
  for (const key of SENSITIVE_KEYS) {
    paths.add(/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `["${key}"]`);
    paths.add(keyPath("*", key));
    paths.add(keyPath("*.*", key));
    paths.add(keyPath("*.*.*", key));
  }
  for (const key of ["authorization", "cookie", "x-api-key"]) {
    paths.add(keyPath("req.headers", key));
  }
  return [...paths];
})();

export const REDACTED = "[redacted]";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export function loggerOptions(level: LogLevel): LoggerOptions {
  return {
    level,
    base: { service: "facilitator" },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
}

export function createLogger(level: LogLevel = "info", destination?: DestinationStream): Logger {
  const options = loggerOptions(level);
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
