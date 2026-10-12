import {
  AgentClient,
  generateSessionKey,
  generateSpendKey,
  PrincipalClient,
  signerFromPrivateKey,
  type OwnerSigner,
  type PolicyDocumentInput,
  type SpendSigner,
} from "@agentbank/sdk";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { FetchLike } from "./net";
import type { Stack } from "./stack";

/**
 * Real-SDK actors over HTTP: a {@link PrincipalClient} (API key + owner key) onboards an org,
 * agent and account, and an {@link AgentClient} (session key + spend key) acts as the agent.
 * Onboarding runs the production order: org → KYB (sandbox auto-approves) → agent → account
 * with a spend key and its float-recovery permit → owner-signed policy → owner-signed session
 * grant and the setup owner operation that deploys the account and executes the permit.
 */

export interface AgentWorld {
  /** Org API key (`abk_test_…`). */
  apiKey: string;
  orgId: string;
  owner: PrivateKeyAccount;
  ownerSigner: OwnerSigner;
  principal: PrincipalClient;
  agentId: string;
  accountId: string;
  accountAddress: string;
  spendKey: PrivateKeyAccount;
  spendKeyAddress: string;
  sessionId: string;
  sessionKey: PrivateKeyAccount;
  /** Agent client bound to the account, session and spend key (and the paying `fetch`). */
  agent: AgentClient;
}

export interface OnboardOptions {
  name?: string;
  policy?: PolicyDocumentInput;
  scope?: {
    max_per_tx?: string;
    max_per_day?: string;
    allowed_recipients?: string[];
    allowed_contracts?: string[];
    expires_at?: string;
  };
  /** Fund the account's operating pocket with this many USDC minor units (faucet + indexer). */
  fund?: bigint;
  /** Fund the spend key with this float (minor units). */
  spendFloat?: bigint;
  /** x402 `fetch` the agent uses for paid resources (resolves test host names to local servers). */
  x402Fetch?: FetchLike;
  /** x402 cap per request (decimal USDC, default "1.00"). */
  maxX402PerCall?: string;
  /** Register the account as an x402 seller for these domains (receive side). */
  x402Domains?: string[];
}

const DEFAULT_POLICY: PolicyDocumentInput = {
  limits: { per_tx: "1000.00", per_day: "5000.00" },
  counterparties: { mode: "open" },
};

/** Create an org and return a principal client holding its API key and owner key. */
export async function createPrincipal(
  stack: Stack,
  name = "Acme Robotics",
  fetchImpl?: FetchLike,
): Promise<{ principal: PrincipalClient; apiKey: string; orgId: string; owner: PrivateKeyAccount }> {
  const owner = privateKeyToAccount(generatePrivateKey());
  const bootstrap = new PrincipalClient({
    baseUrl: stack.apiUrl,
    apiKey: "abk_test_bootstrap",
    owner,
    chainId: stack.chainId,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const created = await bootstrap.orgs.create({
    legal_name: `${name} ${Math.random().toString(36).slice(2, 8)}`,
    kind: "company",
    country: "US",
    contact_email: `ops+${Math.random().toString(36).slice(2, 8)}@example.com`,
    owner_address: owner.address,
  });
  const apiKey = created.api_key.secret;
  const principal = new PrincipalClient({
    baseUrl: stack.apiUrl,
    apiKey,
    owner,
    chainId: stack.chainId,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  await principal.orgs.startKyb().catch(() => undefined); // sandbox KYB auto-approves on create
  return { principal, apiKey, orgId: created.org.id, owner };
}

/**
 * Mint test USDC and wait until the reconciler has posted the deposit (large deposits wait for
 * finality): the address's on-chain balance then equals what the ledger expects for it.
 */
export async function fundAddress(stack: Stack, address: string, amount: bigint): Promise<void> {
  const before = await stack.balanceOf(address);
  await stack.fund(address, amount);
  const target = before + amount;
  await waitFor(
    stack,
    async () => {
      const row = (await stack.expectedOnChain()).find(
        (r) => r.address.toLowerCase() === address.toLowerCase(),
      );
      return row !== undefined && row.onchain === target && row.expected === target;
    },
    `deposit of ${amount} to ${address} posted`,
  );
}

/** Full onboarding with the real SDKs. */
export async function onboardAgent(stack: Stack, options: OnboardOptions = {}): Promise<AgentWorld> {
  const fetchImpl = options.x402Fetch;
  const { principal, apiKey, orgId, owner } = await createPrincipal(
    stack,
    options.name ?? "World",
    fetchImpl,
  );
  const ownerSigner: OwnerSigner = owner;

  // A business plan: unlimited agents, escrow/streams/approvals available.
  await principal.billing.changePlan({ plan: "business" }).catch(() => undefined);

  const agent = await principal.agents.create({ name: options.name ?? "agent" });
  const spendKey = generateSpendKey();
  const sessionKey = generateSessionKey();
  const scope = {
    max_per_tx: options.scope?.max_per_tx ?? "1000.00",
    max_per_day: options.scope?.max_per_day ?? "5000.00",
    ...(options.scope?.allowed_recipients ? { allowed_recipients: options.scope.allowed_recipients } : {}),
    ...(options.scope?.allowed_contracts ? { allowed_contracts: options.scope.allowed_contracts } : {}),
    ...(options.scope?.expires_at ? { expires_at: options.scope.expires_at } : {}),
  };

  // Account + spend key + float-recovery permit, then the owner-signed policy, then the first
  // session (granted and installed by the owner key; the setup operation deploys the account).
  const setup = await principal.setupAgentAccount({
    agentId: agent.id,
    chain: "simulated",
    spendKey: spendKey.account,
    session: { publicKey: sessionKey.address, scope, waitForInstall: true },
  });
  const accountId = setup.account.id;
  await principal.setPolicy(agent.id, options.policy ?? DEFAULT_POLICY);

  // Wait for the setup owner operation to finish deploying the account.
  await waitFor(stack, async () => (await principal.accounts.retrieve(accountId)).deployed, "account deploy");

  if (options.x402Domains && options.x402Domains.length > 0) {
    await principal.x402.registerPayee({ account_id: accountId, domains: options.x402Domains });
  }

  const account = await principal.accounts.retrieve(accountId);
  if (options.fund && options.fund > 0n) await fundAddress(stack, account.address, options.fund);
  if (options.spendFloat && options.spendFloat > 0n && account.spend_key_address) {
    await fundAddress(stack, account.spend_key_address, options.spendFloat);
  }

  const agentClient = new AgentClient({
    baseUrl: stack.apiUrl,
    accountId,
    session: { id: setup.session?.id ?? "", signer: sessionKey.account },
    spendKey: spendKey.account as SpendSigner,
    x402: {
      network: `eip155:${stack.chainId}`,
      maxAmountPerRequest: options.maxX402PerCall ?? "1.00",
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    },
  });

  return {
    apiKey,
    orgId,
    owner,
    ownerSigner,
    principal,
    agentId: agent.id,
    accountId,
    accountAddress: account.address,
    spendKey: spendKey.account,
    spendKeyAddress: account.spend_key_address ?? spendKey.address,
    sessionId: setup.session?.id ?? "",
    sessionKey: sessionKey.account,
    agent: agentClient,
  };
}

/** Poll `check` until it is truthy, pumping the driver between tries. */
export async function waitFor<T>(
  stack: Stack,
  check: () => Promise<T | undefined | false>,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await stack.pump();
    await sleep(15);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fresh viem account (external payee, attacker, …). */
export function randomAccount(): PrivateKeyAccount {
  return signerFromPrivateKey(generatePrivateKey());
}
