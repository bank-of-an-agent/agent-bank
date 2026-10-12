import "server-only";
import { CHAINS, type ChainName } from "@agentbank/core";
import { secureCookies } from "./cookies";

/**
 * Runtime configuration of the console server. Every value is read at request
 * time with a dynamic `process.env` lookup, so one Docker image can be
 * promoted through environments (Next.js only inlines literal
 * `process.env.NEXT_PUBLIC_*` references at build time).
 *
 * | Variable                     | Purpose                                                        |
 * | ---------------------------- | -------------------------------------------------------------- |
 * | `AGENTBANK_API_URL`          | Base URL of `apps/api`, reached server-side only               |
 * | `CONSOLE_SESSION_SECRET`     | ≥ 32 chars; seals the session cookies (required in production) |
 * | `CONSOLE_ORIGIN`             | Public origin(s) of the console, comma-separated (CSRF check)  |
 * | `NEXT_PUBLIC_SANDBOX`        | `true` enables API-key sign-in, sign-up and the sandbox key    |
 * | `NEXT_PUBLIC_AGENTBANK_CHAIN`| `base-sepolia` (default), `anvil` or `simulated`               |
 * | `STAFF_DASHBOARD_ENABLED`    | Staff revenue dashboard (default: on in sandbox only)          |
 * | `COOKIE_SECURE`              | Override the `Secure` cookie flag (default: on in production)  |
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function readEnv(name: string): string | undefined {
  const env = process.env;
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readBool(name: string): boolean | undefined {
  const value = readEnv(name)?.toLowerCase();
  if (value === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new ConfigError(`${name} must be true or false`);
}

export function isProduction(): boolean {
  return readEnv("NODE_ENV") === "production";
}

export interface ServerConfig {
  apiUrl: string;
  sandbox: boolean;
  staffDashboard: boolean;
  secureCookies: boolean;
  /** Origins allowed to make mutating requests; empty means "same host as the request". */
  allowedOrigins: string[];
  chain: ChainName;
}

const DEFAULT_DEV_API_URL = "http://localhost:8080";

function parseOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute URL, got "${value}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${name} must use http or https`);
  }
  return url.origin;
}

export function serverConfig(): ServerConfig {
  const production = isProduction();
  const rawApi = readEnv("AGENTBANK_API_URL") ?? (production ? undefined : DEFAULT_DEV_API_URL);
  if (!rawApi) throw new ConfigError("AGENTBANK_API_URL is required");
  let api: URL;
  try {
    api = new URL(rawApi);
  } catch {
    throw new ConfigError("AGENTBANK_API_URL must be an absolute URL");
  }
  if (api.protocol !== "http:" && api.protocol !== "https:") {
    throw new ConfigError("AGENTBANK_API_URL must use http or https");
  }

  const sandbox = readBool("NEXT_PUBLIC_SANDBOX") ?? false;
  const chainName = readEnv("NEXT_PUBLIC_AGENTBANK_CHAIN") ?? "base-sepolia";
  if (!Object.hasOwn(CHAINS, chainName)) {
    throw new ConfigError(`NEXT_PUBLIC_AGENTBANK_CHAIN must be one of ${Object.keys(CHAINS).join(", ")}`);
  }
  const allowedOrigins = (readEnv("CONSOLE_ORIGIN") ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => parseOrigin(o, "CONSOLE_ORIGIN"));

  return {
    apiUrl: api.toString().replace(/\/+$/, ""),
    sandbox,
    staffDashboard: readBool("STAFF_DASHBOARD_ENABLED") ?? sandbox,
    secureCookies: secureCookies(),
    allowedOrigins,
    chain: chainName as ChainName,
  };
}

/** Settings that are safe to hand to the browser. */
export interface PublicConfig {
  sandbox: boolean;
  staffDashboard: boolean;
  chain: ChainName;
  chainId: number;
}

export function publicConfig(): PublicConfig {
  const cfg = serverConfig();
  return {
    sandbox: cfg.sandbox,
    staffDashboard: cfg.staffDashboard,
    chain: cfg.chain,
    chainId: CHAINS[cfg.chain].id,
  };
}

let ephemeralSecret: string | undefined;
let warned = false;

/**
 * Secret that seals the session cookies. Production requires
 * `CONSOLE_SESSION_SECRET`; development falls back to a per-process random
 * secret (sessions do not survive a restart).
 */
export function sessionSecret(): string {
  const secret = readEnv("CONSOLE_SESSION_SECRET");
  if (secret) {
    if (secret.length < 32) throw new ConfigError("CONSOLE_SESSION_SECRET must be at least 32 characters");
    return secret;
  }
  if (isProduction()) throw new ConfigError("CONSOLE_SESSION_SECRET is required in production");
  if (!ephemeralSecret) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    ephemeralSecret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (!warned) {
    warned = true;
    console.warn("CONSOLE_SESSION_SECRET is not set; using an ephemeral development secret.");
  }
  return ephemeralSecret;
}
