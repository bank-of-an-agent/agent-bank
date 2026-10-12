import { spendKeyPermitTypedData } from "@agentbank/chain";
import { ownerPayloads, SessionScopeSchema, unixSeconds, type PolicyDocumentInput } from "@agentbank/core";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { maxUint256, type Hex } from "viem";
import { pocket } from "../../src/domain/ledger-refs";
import {
  agentCall,
  call,
  createAgent,
  ownerAuth,
  signupOrg,
  type AgentSession,
  type Harness,
  type Json,
  type TestOrg,
} from "./harness";

/**
 * End-to-end onboarding against the real SimulatedChain: org → agent → account (counterfactual
 * address) → initial policy (owner-signed) → session (owner-signed grant) → session install
 * (owner operation deploying the account) → funding.
 */

export const DEFAULT_POLICY: PolicyDocumentInput = {
  limits: { per_tx: "1000.00", per_day: "5000.00" },
  counterparties: { mode: "open" },
};

export interface World extends TestOrg {
  agent: Json;
  account: Json;
  session: AgentSession;
  spendKey: PrivateKeyAccount;
}

export interface OnboardOptions {
  name?: string;
  org?: TestOrg;
  policy?: PolicyDocumentInput;
  scope?: Record<string, unknown>;
  fund?: bigint;
  install?: boolean;
  /** Attach and register the x402 spend key with its permit before setup (default true). */
  attachSpendKey?: boolean;
}

/** A spend key's EIP-2612 float-recovery permit to `spender` (its current USDC nonce). */
export async function signSpendKeyPermit(
  h: Harness,
  spendKey: PrivateKeyAccount,
  spender: string,
  options: { nonce?: bigint; deadlineSeconds?: number } = {},
) {
  const nonce = options.nonce ?? (await h.chain.erc20Nonces(h.chain.contracts.usdc, spendKey.address));
  const deadline = BigInt(unixSeconds(h.clock.now()) + (options.deadlineSeconds ?? 30 * 86_400));
  const signature = await spendKey.signTypedData(
    spendKeyPermitTypedData({
      chainId: h.chain.chainId,
      token: h.chain.contracts.usdc,
      owner: spendKey.address,
      spender: spender as Hex,
      value: maxUint256,
      nonce,
      deadline,
    }),
  );
  return { value: maxUint256.toString(), deadline: deadline.toString(), nonce: nonce.toString(), signature };
}

/**
 * `PUT /v1/accounts/{id}/spend-key`: the owner authorizes pinning the spend key (`spend_key.set`)
 * and the spend key signs its float-recovery permit.
 */
export async function attachSpendKey(
  h: Harness,
  world: Pick<World, "apiKey" | "owner">,
  account: { id: string; address: string },
  spendKey: PrivateKeyAccount,
  permit?: Awaited<ReturnType<typeof signSpendKeyPermit>>,
) {
  const authorization = ownerPayloads.spendKeySet(account.id, spendKey.address);
  return call(h.app, "PUT", `/v1/accounts/${account.id}/spend-key`, {
    token: world.apiKey,
    body: {
      spend_key_address: spendKey.address,
      permit: permit ?? (await signSpendKeyPermit(h, spendKey, account.address)),
      owner_authorization: await ownerAuth(
        world.owner,
        h.clock,
        authorization.action,
        authorization.subject,
        authorization.payload,
      ),
    },
  });
}

/** Sign an operation hash the way every signer does: EIP-191 over the raw 32 bytes. */
export function signHash(key: PrivateKeyAccount, hash: string): Promise<Hex> {
  return key.signMessage({ message: { raw: hash as Hex } });
}

export async function putPolicy(
  h: Harness,
  world: Pick<World, "apiKey" | "owner">,
  agentId: string,
  policy: PolicyDocumentInput,
  sign = true,
) {
  const { PolicyDocumentSchema } = await import("@agentbank/core");
  const parsed = PolicyDocumentSchema.parse(policy);
  const body: Record<string, unknown> = { policy: parsed };
  if (sign)
    body.owner_authorization = await ownerAuth(world.owner, h.clock, "policy.loosen", agentId, parsed);
  return call(h.app, "PUT", `/v1/agents/${agentId}/policy`, { token: world.apiKey, body });
}

/** Sign and submit an owner operation with the org owner key. */
export async function signOwnerOperation(h: Harness, world: Pick<World, "apiKey" | "owner">, opId: string) {
  const op = await call(h.app, "GET", `/v1/owner-operations/${opId}`, { token: world.apiKey });
  if (op.status !== 200) throw new Error(`owner op: ${op.status} ${op.text}`);
  const signature = await signHash(world.owner, op.body.user_op_hash);
  return call(h.app, "POST", `/v1/owner-operations/${opId}/signature`, {
    token: world.apiKey,
    body: { signature },
  });
}

export async function createSession(
  h: Harness,
  world: Pick<World, "apiKey" | "owner">,
  accountId: string,
  scopeOverrides: Record<string, unknown> = {},
): Promise<{ session: Json; key: PrivateKeyAccount }> {
  const key = privateKeyToAccount(generatePrivateKey());
  const scope = SessionScopeSchema.parse({
    max_per_tx: "1000.00",
    max_per_day: "5000.00",
    expires_at: new Date(h.clock.now().getTime() + 24 * 3600 * 1000).toISOString(),
    ...scopeOverrides,
  });
  const owner_authorization = await ownerAuth(world.owner, h.clock, "session.grant", accountId, {
    account_id: accountId,
    public_key: key.address,
    scope,
  });
  const res = await call(h.app, "POST", "/v1/sessions", {
    token: world.apiKey,
    body: { account_id: accountId, public_key: key.address, scope, owner_authorization },
  });
  if (res.status !== 201) throw new Error(`createSession: ${res.status} ${res.text}`);
  return { session: res.body, key };
}

export async function installSession(h: Harness, world: Pick<World, "apiKey" | "owner">, sessionId: string) {
  const res = await call(h.app, "POST", `/v1/sessions/${sessionId}/install`, { token: world.apiKey });
  if (res.status !== 200) throw new Error(`install: ${res.status} ${res.text}`);
  const submitted = await signOwnerOperation(h, world, res.body.install_operation_id);
  if (submitted.status !== 200) throw new Error(`install signature: ${submitted.status} ${submitted.text}`);
  return submitted.body;
}

/**
 * Fund an account: mint test USDC to its address on the simulated chain and let the indexer
 * report the Transfer; the reconciler posts the deposit (`chain −x`, `operating +x`, or `spend`
 * for the spend key's address).
 */
export async function fund(
  h: Harness,
  account: { id: string; address: string; spend_key_address?: string | null },
  amount: bigint,
  pocketName: "operating" | "spend" = "operating",
) {
  const target = pocketName === "spend" ? account.spend_key_address : account.address;
  if (!target) throw new Error("fund: the account has no spend key");
  const ref = pocket(account.id, pocketName);
  const before = await h.ledger.balance(ref);
  h.sim.faucet(target as Hex, amount);
  await h.indexer.sync();
  const after = await h.ledger.balance(ref);
  if (after - before < amount) throw new Error(`fund: deposit not posted (${before} -> ${after})`);
}

export async function onboard(h: Harness, options: OnboardOptions = {}): Promise<World> {
  const org = options.org ?? (await signupOrg(h.app, options.name ?? "World"));
  await h.db.query("UPDATE subscription SET plan_code = 'business' WHERE org_id = $1", [org.org.id]);
  const agent = await createAgent(h.app, org.apiKey, options.name ?? "agent");
  const spendKey = privateKeyToAccount(generatePrivateKey());
  const acct = await call(h.app, "POST", `/v1/agents/${agent.id}/accounts`, {
    token: org.apiKey,
    body: { chain: "simulated", spend_key_address: spendKey.address },
  });
  if (acct.status !== 201) throw new Error(`createAccount: ${acct.status} ${acct.text}`);
  if (options.attachSpendKey !== false) {
    const attached = await attachSpendKey(h, org, acct.body, spendKey);
    if (attached.status !== 200) throw new Error(`attachSpendKey: ${attached.status} ${attached.text}`);
    acct.body = attached.body;
  }
  const policy = await putPolicy(h, org, agent.id, options.policy ?? DEFAULT_POLICY);
  if (policy.status !== 200) throw new Error(`putPolicy: ${policy.status} ${policy.text}`);
  const { session, key } = await createSession(h, org, acct.body.id, options.scope ?? {});
  if (options.install !== false) await installSession(h, org, session.id);
  if (options.fund && options.fund > 0n) await fund(h, acct.body, options.fund);
  return { ...org, agent, account: acct.body, session: { id: session.id, key }, spendKey };
}

/** Agent creates a payment, signs the operation, submits it. Returns the final payment body. */
export async function payAndSign(h: Harness, world: World, body: Record<string, unknown>) {
  const created = await agentCall(h, world.session, "POST", "/v1/payments", {
    body: { account_id: world.account.id, ...body },
  });
  if (created.status !== 201) return created;
  if (created.body.status !== "requires_signature" || !created.body.signing_request?.session_id)
    return created;
  const signature = await signHash(world.session.key, created.body.signing_request.user_op_hash);
  return agentCall(h, world.session, "POST", `/v1/payments/${created.body.id}/signature`, {
    body: { session_id: world.session.id, signature },
  });
}

export const nowSeconds = (h: Harness): number => unixSeconds(h.clock.now());
