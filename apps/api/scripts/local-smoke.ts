/**
 * End-to-end check of the local stack (`pnpm --filter @agentbank/api dev:local`): open signup,
 * agent, account with an x402 spend key and its float-recovery permit, owner-signed policy and
 * session, the setup owner operation, a faucet deposit posted by the reconciler, and an
 * agent-signed payment that the in-process co-signer co-signs and the reconciler settles.
 *
 *   API_URL=http://localhost:8080 pnpm --filter @agentbank/api smoke:local
 *
 * Test keys are generated per run; nothing here touches a real network.
 */
import { spendKeyPermitTypedData } from "@agentbank/chain";
import {
  ownerAuthorizationTypedData,
  ownerPayloads,
  PolicyDocumentSchema,
  SessionScopeSchema,
  signRequest,
  type OwnerAction,
} from "@agentbank/core";
import { maxUint256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const API = (process.env.API_URL ?? "http://localhost:8080").replace(/\/+$/, "");
let counter = 0;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function http(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; session?: { id: string; key: PrivateKeyAccount } } = {},
): Promise<Json> {
  const headers: Record<string, string> = {};
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  if (body !== null) headers["content-type"] = "application/json";
  if (method !== "GET") headers["idempotency-key"] = `smoke-${Date.now()}-${(counter += 1)}`;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.session) {
    const signed = await signRequest(
      { method, url: `${API}${path}`, headers, body },
      { keyId: options.session.id, signer: options.session.key, created: Math.floor(Date.now() / 1000) },
    );
    for (const [k, v] of Object.entries(signed)) if (v !== undefined) headers[k] = v;
  }
  const res = await fetch(`${API}${path}`, { method, headers, ...(body !== null ? { body } : {}) });
  const text = await res.text();
  const json = (text ? JSON.parse(text) : null) as Json;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return json;
}

async function ownerAuth(
  owner: PrivateKeyAccount,
  chainId: number,
  action: OwnerAction,
  subject: string,
  payload: unknown,
) {
  const issuedAt = Math.floor(Date.now() / 1000) - 5;
  const expiresAt = issuedAt + 600;
  const typed = ownerAuthorizationTypedData({ chainId, action, subject, payload, issuedAt, expiresAt });
  return {
    signer: owner.address,
    signature: await owner.signTypedData(typed),
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
}

async function until<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

async function main(): Promise<void> {
  const meta = await http("GET", "/v1/meta");
  const chainId = meta.owner_authorization_chain_id as number;
  const owner = privateKeyToAccount(generatePrivateKey());
  const signup = await http("POST", "/v1/orgs", {
    body: {
      legal_name: "Local Smoke Co",
      kind: "company",
      country: "US",
      contact_email: `smoke+${Date.now()}@example.com`,
      owner_address: owner.address,
    },
  });
  const token = signup.api_key.secret as string;
  const agent = await http("POST", "/v1/agents", { token, body: { name: "smoke-agent" } });
  const spendKey = privateKeyToAccount(generatePrivateKey());
  const account = await http("POST", `/v1/agents/${agent.id}/accounts`, {
    token,
    body: { chain: meta.chain, spend_key_address: spendKey.address },
  });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
  const permitSignature = await spendKey.signTypedData(
    spendKeyPermitTypedData({
      chainId,
      token: meta.usdc.address as Hex,
      owner: spendKey.address,
      spender: account.address as Hex,
      value: maxUint256,
      nonce: 0n,
      deadline,
    }),
  );
  const spendKeySet = ownerPayloads.spendKeySet(account.id, spendKey.address);
  await http("PUT", `/v1/accounts/${account.id}/spend-key`, {
    token,
    body: {
      spend_key_address: spendKey.address,
      permit: {
        value: maxUint256.toString(),
        deadline: deadline.toString(),
        nonce: "0",
        signature: permitSignature,
      },
      owner_authorization: await ownerAuth(
        owner,
        chainId,
        spendKeySet.action,
        spendKeySet.subject,
        spendKeySet.payload,
      ),
    },
  });

  const policy = PolicyDocumentSchema.parse({ limits: { per_tx: "100.00", per_day: "500.00" } });
  await http("PUT", `/v1/agents/${agent.id}/policy`, {
    token,
    body: { policy, owner_authorization: await ownerAuth(owner, chainId, "policy.loosen", agent.id, policy) },
  });
  const sessionKey = privateKeyToAccount(generatePrivateKey());
  const scope = SessionScopeSchema.parse({
    max_per_tx: "50.00",
    max_per_day: "200.00",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const grant = ownerPayloads.sessionGrant({ account_id: account.id, public_key: sessionKey.address, scope });
  const session = await http("POST", "/v1/sessions", {
    token,
    body: {
      account_id: account.id,
      public_key: sessionKey.address,
      scope,
      owner_authorization: await ownerAuth(owner, chainId, grant.action, grant.subject, grant.payload),
    },
  });
  const install = await http("POST", `/v1/sessions/${session.id}/install`, { token });
  const op = await http("GET", `/v1/owner-operations/${install.install_operation_id}`, { token });
  const installed = await http("POST", `/v1/owner-operations/${op.id}/signature`, {
    token,
    body: { signature: await owner.signMessage({ message: { raw: op.user_op_hash as Hex } }) },
  });
  console.log("setup operation:", installed.status);
  const setUp = await http("GET", `/v1/accounts/${account.id}`, { token });
  console.log("account deployed:", setUp.deployed, "spend key permit:", setUp.spend_key_permit);

  await http("POST", "/v1/sandbox/faucet", {
    token,
    body: { account_id: account.id, amount: { amount: "100.00", asset: "USDC" } },
  });
  const funded = await until("the deposit", async () => {
    const b = await http("GET", `/v1/accounts/${account.id}/balances`, { token });
    return Number(b.available) >= 100 ? b : undefined;
  });
  console.log("available after faucet:", funded.available);

  const agentSession = { id: session.id as string, key: sessionKey };
  const payment = await http("POST", "/v1/payments", {
    session: agentSession,
    body: {
      account_id: account.id,
      amount: { amount: "5.00", asset: "USDC" },
      to: { address: privateKeyToAccount(generatePrivateKey()).address },
      memo: "local smoke",
    },
  });
  const submitted = await http("POST", `/v1/payments/${payment.id}/signature`, {
    session: agentSession,
    body: {
      session_id: session.id,
      signature: await sessionKey.signMessage({
        message: { raw: payment.signing_request.user_op_hash as Hex },
      }),
    },
  });
  console.log("payment:", submitted.status, "fee:", submitted.fee.amount);
  const settled = await until("settlement", async () => {
    const p = await http("GET", `/v1/payments/${payment.id}`, { token });
    return p.status === "settled" ? p : undefined;
  });
  console.log("payment settled in tx", settled.tx_hash);
  const balances = await http("GET", `/v1/accounts/${account.id}/balances`, { token });
  console.log("balances:", JSON.stringify(balances));
  console.log("OK");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
