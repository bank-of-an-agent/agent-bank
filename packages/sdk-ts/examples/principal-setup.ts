/**
 * Principal setup: sign up an org, create an agent with a spending policy,
 * provision its smart account with an x402 spend key (plus float-recovery
 * permit) and a session key, and write the agent's keys to a 0600 key file.
 * Testnet only (Base Sepolia / local API).
 *
 *   AGENTBANK_API_URL=http://localhost:8080 \
 *   AGENTBANK_OWNER_KEY=0x…   # optional: your testnet owner key (a new one is generated otherwise)
 *   pnpm --filter @agentbank/sdk exec tsx examples/principal-setup.ts
 *
 * Prints the env vars the agent (or `agentbank-mcp`) needs.
 */
import {
  AgentBankClient,
  generateSessionKey,
  generateSpendKey,
  PrincipalClient,
  signerFromPrivateKey,
} from "@agentbank/sdk";
import { FileKeyStore } from "@agentbank/sdk/node";
import { generatePrivateKey } from "viem/accounts";

const baseUrl = process.env.AGENTBANK_API_URL ?? "http://localhost:8080";
const keystorePath = process.env.AGENTBANK_KEYSTORE ?? ".agentbank/agent.keystore.json";

// The owner key belongs to the principal (a passkey or hardware wallet in production).
const owner = signerFromPrivateKey(process.env.AGENTBANK_OWNER_KEY ?? generatePrivateKey());

// 1. Sign up (public route) and keep the admin API key it returns.
const { org, api_key } = await new AgentBankClient({ baseUrl }).orgs.create({
  legal_name: "Example Research Ltd",
  kind: "company",
  country: "GB",
  contact_email: "ops@example.test",
  owner_address: owner.address,
});
console.log(`org ${org.id} (KYB ${org.kyc_status})`);

const principal = new PrincipalClient({ baseUrl, apiKey: api_key.secret, owner });

// 2. An agent with spending rules: caps, an x402 allowlist and an approval threshold.
const agent = await principal.agents.create({
  name: "research-bot",
  description: "Buys datasets and API calls",
});
await principal.setPolicy(agent.id, {
  limits: { per_tx: "25.00", per_day: "200.00", per_month: "2000.00" },
  counterparties: {
    mode: "allowlist",
    addresses: ["0x2222222222222222222222222222222222222222"],
    x402_domains: ["api.example-data.com", "localhost"],
  },
  approvals: [{ above: "100.00", approvers: 1 }],
});

// 3. Its smart account, x402 spend key and first session, in the order the contracts need:
//    create the account → the spend key signs the float-recovery permit for the account's
//    address (ADR 0001) → attach it → grant a 24-hour session whose on-chain install
//    (signed by the owner) also executes the permit.
const spendKey = generateSpendKey();
const sessionKey = generateSessionKey();
const { account, session, installOperation } = await principal.setupAgentAccount({
  agentId: agent.id,
  chain: "base-sepolia",
  spendKey: spendKey.account,
  session: { publicKey: sessionKey.address, scope: { max_per_tx: "25.00", max_per_day: "200.00" } },
});
if (!session) throw new Error("expected a session");
console.log(`agent ${agent.id}, account ${account.id} at ${account.address} (fund it with test USDC)`);
console.log(
  `spend key ${account.spend_key_address} (permit ${account.spend_key_permit}); session ${session.id} (${session.status}); install ${installOperation?.status ?? "n/a"}`,
);

// 4. Hand the keys to the agent runtime through a 0600 key file (never logs or env dumps).
const store = new FileKeyStore({ path: keystorePath });
await store.set(`session:${session.id}`, sessionKey.privateKey);
await store.set("spend", spendKey.privateKey);

console.log(`
export AGENTBANK_API_URL=${baseUrl}
export AGENTBANK_ACCOUNT_ID=${account.id}
export AGENTBANK_SESSION_ID=${session.id}
export AGENTBANK_KEYSTORE=${keystorePath}`);
