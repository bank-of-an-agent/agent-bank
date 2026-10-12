/**
 * Build the agent's Agent Bank client from the environment, using the same
 * variables as the `agentbank-mcp` server:
 *
 * | Variable | Meaning |
 * | --- | --- |
 * | `AGENTBANK_API_URL` | API base URL (default `http://localhost:8080`) |
 * | `AGENTBANK_ACCOUNT_ID` | The agent's account (`acct_…`) |
 * | `AGENTBANK_SESSION_ID` | The session (`ses_…`) |
 * | `AGENTBANK_KEYSTORE` | 0600 key file with `session:<ses_id>` and `spend` (default `.agentbank/agent.keystore.json`) |
 * | `AGENTBANK_SESSION_KEY` / `AGENTBANK_SPEND_KEY` | Keys from your secret manager instead of the key file |
 * | `AGENTBANK_MAX_PER_PAYMENT`, `AGENTBANK_MAX_PER_RUN`, `AGENTBANK_MAX_PER_HTTP_REQUEST` | Client-side limits (USDC) |
 *
 * The agent holds only its session key and x402 spend key. It never sees an
 * org API key or the owner key.
 */
import { AgentClient, signerFromPrivateKey } from "@agentbank/sdk";
import { FileKeyStore, loadKey } from "@agentbank/sdk/node";
import { DEFAULT_LIMITS, type SpendLimits } from "./money-tools";

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required (run the principal setup first)`);
  return value;
}

/** An `AgentClient` authenticated with the session key, with the x402 spend key when available. */
export async function agentFromEnv(env: Env = process.env): Promise<AgentClient> {
  const accountId = required(env, "AGENTBANK_ACCOUNT_ID");
  const sessionId = required(env, "AGENTBANK_SESSION_ID");
  const keystorePath = env.AGENTBANK_KEYSTORE ?? ".agentbank/agent.keystore.json";
  const store = new FileKeyStore({ path: keystorePath });

  const sessionKey = env.AGENTBANK_SESSION_KEY
    ? signerFromPrivateKey(env.AGENTBANK_SESSION_KEY)
    : await loadKey(store, `session:${sessionId}`);
  if (!sessionKey) {
    throw new Error(
      `No session key: set AGENTBANK_SESSION_KEY or store "session:${sessionId}" in ${keystorePath}`,
    );
  }
  const spendKey = env.AGENTBANK_SPEND_KEY
    ? signerFromPrivateKey(env.AGENTBANK_SPEND_KEY)
    : await loadKey(store, "spend");

  return new AgentClient({
    baseUrl: env.AGENTBANK_API_URL ?? "http://localhost:8080",
    accountId,
    session: { id: sessionId, signer: sessionKey },
    ...(spendKey ? { spendKey } : {}),
  });
}

/** Client-side limits from the environment, defaulting to `DEFAULT_LIMITS`. */
export function limitsFromEnv(env: Env = process.env): SpendLimits {
  return {
    maxPerPayment: env.AGENTBANK_MAX_PER_PAYMENT ?? DEFAULT_LIMITS.maxPerPayment,
    maxPerRun: env.AGENTBANK_MAX_PER_RUN ?? DEFAULT_LIMITS.maxPerRun,
    maxPerHttpRequest: env.AGENTBANK_MAX_PER_HTTP_REQUEST ?? DEFAULT_LIMITS.maxPerHttpRequest,
  };
}
