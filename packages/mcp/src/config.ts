import {
  AgentBankError,
  isPrivateKey,
  normalizeAmount,
  signerFromPrivateKey,
  x402ChainId,
  type SpendSigner,
} from "@agentbank/sdk";
import { FileKeyStore } from "@agentbank/sdk/node";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * Configuration of the MCP server, read from the environment. Keys are
 * loaded into signer objects and never logged, echoed in errors or returned
 * by tools.
 *
 * | Variable | Meaning |
 * | --- | --- |
 * | `AGENTBANK_API_URL` | API base URL (default `http://localhost:8080`) |
 * | `AGENTBANK_ACCOUNT_ID` | The agent's account (`acct_…`), required |
 * | `AGENTBANK_SESSION_ID` | The session (`ses_…`), required |
 * | `AGENTBANK_SESSION_KEY` | Session private key (0x…), or use `AGENTBANK_KEYSTORE` |
 * | `AGENTBANK_KEYSTORE` | Path of a `FileKeyStore` (0600) holding `session:<ses_id>` (or `session`) and optionally `spend` |
 * | `AGENTBANK_SPEND_KEY` | x402 spend key (0x…); without one, `fetch_paid_resource` cannot pay |
 * | `AGENTBANK_MAX_X402_PER_CALL` | Cap per paid request in USDC (default `1.00`) |
 * | `AGENTBANK_X402_NETWORK` | Optional CAIP-2 network to pay x402 on (default: the deployment's, from `GET /v1/meta`) |
 * | `AGENTBANK_MCP_HTTP_TOKEN` | Bearer token required by the HTTP transport (required when binding beyond loopback) |
 *
 * @packageDocumentation
 */

/** Resolved configuration. */
export interface McpConfig {
  apiUrl: string;
  accountId: string;
  sessionId: string;
  sessionKey: PrivateKeyAccount;
  spendKey: SpendSigner | undefined;
  maxX402PerCall: string;
  /** Explicit x402 network (CAIP-2); `undefined` = the deployment's, from `GET /v1/meta`. */
  x402Network: string | undefined;
  httpToken: string | undefined;
  /** Where the session key came from (for startup logs; never the key itself). */
  sessionKeySource: "env" | "keystore";
}

/** Thrown for missing or invalid configuration. Messages never contain secrets. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const ID_BODY = "[0-9A-HJKMNP-TV-Z]{26}";

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

function key(env: Record<string, string | undefined>, name: string): PrivateKeyAccount | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!isPrivateKey(value)) throw new ConfigError(`${name} must be a 0x-prefixed 32-byte hex private key`);
  return signerFromPrivateKey(value);
}

/**
 * Load and validate the configuration.
 *
 * @throws {@link ConfigError} with a message that names the variable but never its value.
 */
export async function loadConfig(env: Record<string, string | undefined> = process.env): Promise<McpConfig> {
  const apiUrl = (env.AGENTBANK_API_URL?.trim() || "http://localhost:8080").replace(/\/+$/, "");
  try {
    const url = new URL(apiUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new ConfigError("AGENTBANK_API_URL must be an http(s) URL");
  }
  const accountId = required(env, "AGENTBANK_ACCOUNT_ID");
  if (!new RegExp(`^acct_${ID_BODY}$`).test(accountId)) {
    throw new ConfigError("AGENTBANK_ACCOUNT_ID must be an account id (acct_…)");
  }
  const sessionId = required(env, "AGENTBANK_SESSION_ID");
  if (!new RegExp(`^ses_${ID_BODY}$`).test(sessionId)) {
    throw new ConfigError("AGENTBANK_SESSION_ID must be a session id (ses_…)");
  }

  let sessionKey = key(env, "AGENTBANK_SESSION_KEY");
  let spendKey: SpendSigner | undefined = key(env, "AGENTBANK_SPEND_KEY");
  let sessionKeySource: McpConfig["sessionKeySource"] = "env";
  const keystorePath = env.AGENTBANK_KEYSTORE?.trim();
  if (keystorePath && (!sessionKey || !spendKey)) {
    const store = new FileKeyStore({ path: keystorePath });
    try {
      if (!sessionKey) {
        const stored = (await store.get(`session:${sessionId}`)) ?? (await store.get("session"));
        if (stored) {
          sessionKey = signerFromPrivateKey(stored);
          sessionKeySource = "keystore";
        }
      }
      if (!spendKey) {
        const stored = (await store.get(`spend:${accountId}`)) ?? (await store.get("spend"));
        if (stored) spendKey = signerFromPrivateKey(stored);
      }
    } catch (error) {
      throw new ConfigError(
        `AGENTBANK_KEYSTORE: ${error instanceof AgentBankError || error instanceof Error ? error.message : "unreadable"}`,
      );
    }
  }
  if (!sessionKey) {
    throw new ConfigError(
      keystorePath
        ? `No session key for ${sessionId} in AGENTBANK_KEYSTORE (expected "session:${sessionId}" or "session")`
        : "Set AGENTBANK_SESSION_KEY or AGENTBANK_KEYSTORE",
    );
  }

  let maxX402PerCall: string;
  try {
    maxX402PerCall = normalizeAmount(
      env.AGENTBANK_MAX_X402_PER_CALL?.trim() || "1.00",
      "AGENTBANK_MAX_X402_PER_CALL",
    );
  } catch {
    throw new ConfigError('AGENTBANK_MAX_X402_PER_CALL must be a decimal USDC amount such as "0.50"');
  }

  const x402Network = env.AGENTBANK_X402_NETWORK?.trim() || undefined;
  if (x402Network !== undefined) {
    try {
      x402ChainId(x402Network);
    } catch (error) {
      throw new ConfigError(
        error instanceof AgentBankError && error.code === "mainnet_locked"
          ? "AGENTBANK_X402_NETWORK is a mainnet; Agent Bank is testnet-only"
          : 'AGENTBANK_X402_NETWORK must be a CAIP-2 network such as "eip155:84532"',
      );
    }
  }

  const httpToken = env.AGENTBANK_MCP_HTTP_TOKEN?.trim() || undefined;
  if (httpToken !== undefined && httpToken.length < 16) {
    throw new ConfigError("AGENTBANK_MCP_HTTP_TOKEN must be at least 16 characters");
  }

  return {
    apiUrl,
    accountId,
    sessionId,
    sessionKey,
    spendKey,
    maxX402PerCall,
    x402Network,
    httpToken,
    sessionKeySource,
  };
}
