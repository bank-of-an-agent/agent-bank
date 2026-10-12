/**
 * Principal setup: sign up an org, create an agent with a smart account,
 * give it a spending policy and a session key, and write the agent's keys to
 * a 0600 key file. Testnet only (Base Sepolia / local API).
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

// 2. An agent with its own smart account; the x402 spend key is generated client-side.
const agent = await principal.agents.create({
  name: "research-bot",
  description: "Buys datasets and API calls",
});
const spendKey = generateSpendKey();
const account = await principal.accounts.create(agent.id, {
  chain: "base-sepolia",
  spend_key_address: spendKey.address,
});
console.log(`agent ${agent.id}, account ${account.id} at ${account.address} (fund it with test USDC)`);

// 3. Spending rules: caps, an x402 allowlist and an approval threshold.
await principal.setPolicy(agent.id, {
  limits: { per_tx: "25.00", per_day: "200.00", per_month: "2000.00" },
  counterparties: {
    mode: "allowlist",
    addresses: ["0x2222222222222222222222222222222222222222"],
    x402_domains: ["api.example-data.com", "localhost"],
  },
  approvals: [{ above: "100.00", approvers: 1 }],
});

// 4. A 24-hour session key, scoped on-chain, installed with the owner's signature.
const sessionKey = generateSessionKey();
const { session, installOperation } = await principal.grantSession({
  accountId: account.id,
  publicKey: sessionKey.address,
  scope: { max_per_tx: "25.00", max_per_day: "200.00" },
});
console.log(
  `session ${session.id} (${session.status}); install operation ${installOperation?.status ?? "n/a"}`,
);

// 5. Hand the keys to the agent runtime through a 0600 key file (never logs or env dumps).
const store = new FileKeyStore({ path: keystorePath });
await store.set(`session:${session.id}`, sessionKey.privateKey);
await store.set("spend", spendKey.privateKey);

console.log(`
export AGENTBANK_API_URL=${baseUrl}
export AGENTBANK_ACCOUNT_ID=${account.id}
export AGENTBANK_SESSION_ID=${session.id}
export AGENTBANK_KEYSTORE=${keystorePath}`);
