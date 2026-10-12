import { usdc } from "@agentbank/core";
import { generateSessionKey, generateSpendKey, PrincipalClient } from "@agentbank/sdk";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { startDemoSeller } from "./seller";
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
 *   paying to a sandbox seller account.
 * - prints the org API key and the agent's AGENTBANK_* env block (the same variables the MCP
 *   server and the framework examples read).
 */

const API_PORT = Number(process.env.SANDBOX_API_PORT ?? 8080);
const FACILITATOR_PORT = Number(process.env.SANDBOX_FACILITATOR_PORT ?? 8083);
const SELLER_PORT = Number(process.env.SANDBOX_SELLER_PORT ?? 4021);

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
  const stack = await startStack({
    apiPort: API_PORT,
    facilitatorPort: FACILITATOR_PORT,
    logLevel: (process.env.LOG_LEVEL as "info") ?? "info",
    driverIntervalMs: 100,
    persistentDb: persistent,
  });

  // The demo seller's Agent Bank account (receives x402 payments; the 0.5% fee accrues to it).
  const seller = await createOrg(stack.apiUrl, stack.chainId, "Sandbox Seller Co");
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
  });

  // A ready-to-use agent with an open policy, funded operating balance and x402 float.
  const buyer = await createOrg(stack.apiUrl, stack.chainId, "Sandbox Co");
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

  // Bind on 127.0.0.1 but advertise `localhost`: x402 domains must be host names, not IPs, and
  // the seller is registered for the `localhost` domain.
  const asLocalhost = (url: string): string => url.replace("127.0.0.1", "localhost");
  const apiUrl = asLocalhost(stack.apiUrl);
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
  out(`Facilitator    ${facilitatorUrl}`);
  out(`Demo seller    ${sellerUrl}`);
  out(`  GET /weather $0.01   (settled after serving)`);
  out(`  GET /report  $2.00   (settled before serving)`);
  out(line);
  out("Org API key (principal; keep it secret):");
  out(`  AGENTBANK_API_URL=${apiUrl}`);
  out(`  AGENTBANK_API_KEY=${buyer.apiKey}`);
  out("");
  out("Agent env block (session + x402 spend key; the MCP server and examples read these):");
  out(`  AGENTBANK_API_URL=${apiUrl}`);
  out(`  AGENTBANK_ACCOUNT_ID=${setup.account.id}`);
  out(`  AGENTBANK_SESSION_ID=${setup.session?.id ?? ""}`);
  out(`  AGENTBANK_SESSION_KEY=${sessionKey.privateKey}`);
  out(`  AGENTBANK_SPEND_KEY=${spendKey.privateKey}`);
  out(`  AGENTBANK_MAX_X402_PER_CALL=1.00`);
  out(line);
  out("Try it:");
  out(`  curl ${apiUrl}/v1/meta`);
  out(`  curl ${sellerUrl}/weather    # 402 Payment Required (pay it with the agent SDK or MCP)`);
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
