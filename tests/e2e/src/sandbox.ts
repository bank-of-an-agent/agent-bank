import { usdc } from "@agentbank/core";
import {
  AgentClient,
  generateProofSecret,
  generateSessionKey,
  generateSpendKey,
  PrincipalClient,
  type DisclosureClass,
} from "@agentbank/sdk";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { publishProofRoot } from "./proofs";
import { DEMO_PROOF_ROUTES, startDemoSeller } from "./seller";
import { startStack } from "./stack";
import { waitFor } from "./actors";

/**
 * `pnpm --filter @agentbank/e2e sandbox`: the whole stack on fixed ports, running until Ctrl-C,
 * with a demo x402 seller and a ready-to-use org and agent. Persists nothing unless
 * `DATABASE_URL` is set. Not a test (kept out of `vitest run`): a hand-run local playground the
 * docs and quickstarts can point at.
 *
 * - API on http://localhost:8080, facilitator on http://localhost:8083/v1/x402
 * - demo seller on http://localhost:4021 with GET /weather ($0.01) and GET /report ($2.00),
 *   paying to a sandbox seller account, and the proof-gated GET /premium, /bid and /jobs
 *   (private proofs, scope `localhost`).
 * - prints the org API key and the agent's AGENTBANK_* env block (the same variables the MCP
 *   server and the framework examples read), including AGENTBANK_PROOF_SECRET: the agent has
 *   private proofs enabled for every disclosure class (owner-signed) and its secret enrolled.
 */

const API_PORT = Number(process.env.SANDBOX_API_PORT ?? 8080);
const FACILITATOR_PORT = Number(process.env.SANDBOX_FACILITATOR_PORT ?? 8083);
const SELLER_PORT = Number(process.env.SANDBOX_SELLER_PORT ?? 4021);
/**
 * Both sandbox agents (the demo seller's and yours) are enrolled, so every root has at least two
 * leaves; the gates and `PROOFS_MIN_ANONYMITY_SET` accept that. Real deployments require 16.
 */
const MIN_ANONYMITY_SET = 2;
/** The seller's proof scope: the host name agents reach it at. */
const PROOF_SCOPE = "localhost";
const ALL_CLASSES: DisclosureClass[] = [
  "principal",
  "limits",
  "balance",
  "reservations",
  "account_age",
  "reputation",
];

async function createOrg(
  apiUrl: string,
  chainId: number,
  name: string,
): Promise<{ principal: PrincipalClient; apiKey: string; owner: PrivateKeyAccount }> {
  const owner = privateKeyToAccount(generatePrivateKey());
  const bootstrap = new PrincipalClient({ baseUrl: apiUrl, apiKey: "abk_test_bootstrap", owner, chainId });
  const created = await bootstrap.orgs.create({
    legal_name: name,
    kind: "company",
    country: "US",
    contact_email: `sandbox+${Math.random().toString(36).slice(2, 8)}@example.com`,
    owner_address: owner.address,
  });
  const principal = new PrincipalClient({ baseUrl: apiUrl, apiKey: created.api_key.secret, owner, chainId });
  await principal.orgs.startKyb().catch(() => undefined);
  await principal.billing.changePlan({ plan: "business" }).catch(() => undefined);
  return { principal, apiKey: created.api_key.secret, owner };
}

async function main(): Promise<void> {
  const persistent = Boolean(process.env.DATABASE_URL);
  // The API binds 127.0.0.1 but is advertised (and signed for: RFC 9421 covers the target URI,
  // checked against PUBLIC_BASE_URL) as `localhost`, the URL the env block below prints.
  const apiUrl = `http://localhost:${API_PORT}`;
  const stack = await startStack({
    apiPort: API_PORT,
    facilitatorPort: FACILITATOR_PORT,
    logLevel: (process.env.LOG_LEVEL as "info") ?? "info",
    driverIntervalMs: 100,
    // Keep the world on wall-clock time: agents in other processes sign with real timestamps.
    realTimeBlocks: true,
    persistentDb: persistent,
    env: {
      PUBLIC_BASE_URL: apiUrl,
      PROOFS_MIN_ANONYMITY_SET: String(MIN_ANONYMITY_SET),
      // Re-attest balances and track records every minute (production: hourly).
      PROOFS_ROOT_INTERVAL_SECONDS: "60",
    },
  });

  // The demo seller's Agent Bank account (receives x402 payments; the 0.5% fee accrues to it).
  const seller = await createOrg(apiUrl, stack.chainId, "Sandbox Seller Co");
  const sellerAgent = await seller.principal.agents.create({ name: "weather-api" });
  const sellerSpend = generateSpendKey();
  const sellerSession = generateSessionKey();
  const sellerSetup = await seller.principal.setupAgentAccount({
    agentId: sellerAgent.id,
    chain: "simulated",
    spendKey: sellerSpend.account,
    session: {
      publicKey: sellerSession.address,
      scope: { max_per_tx: "100.00", max_per_day: "1000.00" },
      waitForInstall: true,
    },
  });
  await seller.principal.setPolicy(sellerAgent.id, {
    limits: { per_tx: "100.00", per_day: "1000.00" },
    counterparties: { mode: "open" },
  });
  await waitFor(
    stack,
    async () => (await seller.principal.accounts.retrieve(sellerSetup.account.id)).deployed,
    "seller account deploy",
  );
  await seller.principal.x402.registerPayee({
    account_id: sellerSetup.account.id,
    domains: ["localhost"],
  });
  const demoSeller = await startDemoSeller({
    facilitatorUrl: stack.facilitatorUrl,
    payTo: sellerSetup.account.address,
    network: `eip155:${stack.chainId}`,
    port: SELLER_PORT,
    proofs: { apiUrl: stack.apiUrl, scope: PROOF_SCOPE, minAnonymitySet: MIN_ANONYMITY_SET },
  });

  // A ready-to-use agent with an open policy, funded operating balance and x402 float.
  const buyer = await createOrg(apiUrl, stack.chainId, "Sandbox Co");
  const buyerAgent = await buyer.principal.agents.create({ name: "sandbox-agent" });
  const spendKey = generateSpendKey();
  const sessionKey = generateSessionKey();
  const setup = await buyer.principal.setupAgentAccount({
    agentId: buyerAgent.id,
    chain: "simulated",
    spendKey: spendKey.account,
    session: {
      publicKey: sessionKey.address,
      scope: { max_per_tx: "500.00", max_per_day: "2000.00" },
      waitForInstall: true,
    },
  });
  await buyer.principal.setPolicy(buyerAgent.id, {
    limits: { per_tx: "500.00", per_day: "2000.00" },
    counterparties: { mode: "open" },
    approvals: [{ above: "250.00", approvers: 1 }],
  });
  await waitFor(
    stack,
    async () => (await buyer.principal.accounts.retrieve(setup.account.id)).deployed,
    "agent account deploy",
  );
  const account = await buyer.principal.accounts.retrieve(setup.account.id);
  stack.sim.faucet(account.address as `0x${string}`, usdc("1000"));
  if (account.spend_key_address) stack.sim.faucet(account.spend_key_address as `0x${string}`, usdc("25"));
  await waitFor(
    stack,
    async () => Number((await buyer.principal.accounts.balances(setup.account.id)).available) >= 1000,
    "agent funded",
  );

  // Private proofs: the owners enable them (owner-signed: enabling widens disclosure) and each
  // agent enrolls Poseidon(secret). Your agent discloses every class; the seller's agent only
  // joins the tree, so proofs hide your agent among two.
  const proofSecret = generateProofSecret();
  await buyer.principal.proofs.configure(buyerAgent.id, { enabled: true, disclose: ALL_CLASSES });
  await new AgentClient({
    baseUrl: apiUrl,
    accountId: setup.account.id,
    session: { id: setup.session?.id ?? "", signer: sessionKey.account },
    proofSecret,
  }).proofs.enroll();
  await seller.principal.proofs.configure(sellerAgent.id, { enabled: true, disclose: ["principal"] });
  await new AgentClient({
    baseUrl: apiUrl,
    accountId: sellerSetup.account.id,
    session: { id: sellerSetup.session?.id ?? "", signer: sellerSession.account },
    proofSecret: generateProofSecret(),
  }).proofs.enroll();
  const root = await publishProofRoot(stack);

  // Bind on 127.0.0.1 but advertise `localhost`: x402 domains must be host names, not IPs, and
  // the seller is registered for the `localhost` domain (also its proof scope).
  const asLocalhost = (url: string): string => url.replace("127.0.0.1", "localhost");
  const facilitatorUrl = asLocalhost(stack.facilitatorUrl);
  const sellerUrl = asLocalhost(demoSeller.url);
  const line = "─".repeat(72);
  const out = (s = "") => process.stdout.write(`${s}\n`);
  out(line);
  out("Agent Bank local sandbox is up (simulated chain, in one process).");
  out(persistent ? "Persisting to DATABASE_URL." : "In-memory (PGlite): nothing persists after Ctrl-C.");
  out(line);
  out(`API            ${apiUrl}`);
  out(`  meta         ${apiUrl}/v1/meta`);
  out(`  health       ${apiUrl}/healthz`);
  out(`  proof roots  ${apiUrl}/v1/proofs/roots`);
  out(`Facilitator    ${facilitatorUrl}`);
  out(`Demo seller    ${sellerUrl}`);
  out(`  GET /weather $0.01   (settled after serving)`);
  out(`  GET /report  $2.00   (settled before serving)`);
  out(`  Private proofs (401 + AGENT-PROOF-REQUIRED; scope "${PROOF_SCOPE}"), the agent proves:`);
  for (const route of DEMO_PROOF_ROUTES) out(`  GET ${route.path.padEnd(9)}${route.proves}`);
  out(line);
  out("Private proofs:");
  out(`  Your agent discloses every class (owner-signed) and its secret is enrolled; root #${root.epoch}`);
  out(`  has ${root.leaf_count} leaves. Both sandbox agents are enrolled, so the seller's gates (and`);
  out(
    `  PROOFS_MIN_ANONYMITY_SET) accept an anonymity set of ${MIN_ANONYMITY_SET}: a proof hides your agent among`,
  );
  out("  two. Real deployments require at least 16 (the SDK default); never lower it in production.");
  out("  Roots rebuild within a second of a change (production: every 30 s) and re-attest balances");
  out("  and track records every minute (PROOFS_ROOT_INTERVAL_SECONDS=60; production: hourly).");
  out(line);
  out("Org API key (principal; keep it secret):");
  out(`  AGENTBANK_API_URL=${apiUrl}`);
  out(`  AGENTBANK_API_KEY=${buyer.apiKey}`);
  out("");
  out("Agent env block (session + x402 spend key + proof secret; the MCP server and examples read these):");
  out(`  AGENTBANK_API_URL=${apiUrl}`);
  out(`  AGENTBANK_ACCOUNT_ID=${setup.account.id}`);
  out(`  AGENTBANK_SESSION_ID=${setup.session?.id ?? ""}`);
  out(`  AGENTBANK_SESSION_KEY=${sessionKey.privateKey}`);
  out(`  AGENTBANK_SPEND_KEY=${spendKey.privateKey}`);
  out(`  AGENTBANK_PROOF_SECRET=${proofSecret}`);
  out(`  AGENTBANK_MAX_X402_PER_CALL=1.00`);
  out(line);
  out("Try it:");
  out(`  curl ${apiUrl}/v1/meta`);
  out(`  curl ${sellerUrl}/weather    # 402 Payment Required (pay it with the agent SDK or MCP)`);
  out(`  curl -i ${sellerUrl}/premium # 401 + AGENT-PROOF-REQUIRED (base64 JSON proof request)`);
  out(`  agent.fetchWithPayment("${sellerUrl}/premium")  # proves (401), then pays $0.05 (402)`);
  out(`  agent.fetchWithPayment("${sellerUrl}/jobs")     # proves a clean dispute record`);
  out(`  agent.proofs.reserve({ amount: "25.00", scope: "${PROOF_SCOPE}", forSeconds: 3600 })`);
  out(`    then agent.fetchWithPayment("${sellerUrl}/bid")  # $25 held for this seller only`);
  out("  (AgentClient with proofSecret: AGENTBANK_PROOF_SECRET; MCP: prove_claims, fetch_paid_resource)");
  out("Press Ctrl-C to stop.");
  out(line);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    out(`\nReceived ${signal}, shutting down…`);
    await demoSeller.close().catch(() => undefined);
    await stack.stopStack().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Keep the process alive.
  await new Promise(() => undefined);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
