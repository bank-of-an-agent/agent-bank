/**
 * Pay-per-call with x402: fetch a resource; if the server answers 402, the
 * SDK asks Agent Bank for an EIP-3009 authorization within policy, signs it
 * with the agent's spend key and retries with the payment header.
 *
 *   AGENTBANK_API_URL=http://localhost:8080 AGENTBANK_ACCOUNT_ID=acct_… \
 *   AGENTBANK_SESSION_ID=ses_… AGENTBANK_KEYSTORE=.agentbank/agent.keystore.json \
 *   pnpm --filter @agentbank/sdk exec tsx examples/x402-fetch.ts http://localhost:4021/weather
 *
 * Pair it with examples/seller-paywall.ts.
 */
import { AgentClient } from "@agentbank/sdk";
import { FileKeyStore, loadKey } from "@agentbank/sdk/node";

const url = process.argv[2] ?? "http://localhost:4021/weather";
const sessionId = process.env.AGENTBANK_SESSION_ID ?? "";
const store = new FileKeyStore({ path: process.env.AGENTBANK_KEYSTORE ?? ".agentbank/agent.keystore.json" });
const sessionKey = await loadKey(store, `session:${sessionId}`);
const spendKey = await loadKey(store, "spend");
if (!sessionKey || !spendKey) throw new Error("Run examples/principal-setup.ts first");

const agent = new AgentClient({
  baseUrl: process.env.AGENTBANK_API_URL ?? "http://localhost:8080",
  accountId: process.env.AGENTBANK_ACCOUNT_ID ?? "",
  session: { id: sessionId, signer: sessionKey },
  spendKey,
  // Defense in depth on top of the server-side policy: never pay more than this per request.
  x402: { maxAmountPerRequest: "0.10" },
});

const result = await agent.fetchWithPayment(url);
console.log(
  `HTTP ${result.response.status}${result.paid ? `, paid ${result.amount} USDC` : ", no payment needed"}`,
);
if (result.settlement)
  console.log(`settled on ${result.settlement.network}: ${result.settlement.transaction}`);
console.log(await result.response.text());
