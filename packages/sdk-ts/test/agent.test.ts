import { parseSignatureInput } from "@agentbank/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentClient,
  AuthenticationError,
  ConflictError,
  InvalidRequestError,
  PaymentFailedError,
  PolicyDeniedError,
  type AgentClientOptions,
} from "../src";
import { startFakeApi, type FakeApi } from "./helpers/fake-api";

const ACCT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SES = "ses_01JABCDEFGHJKMNPQRSTVWXYZ0";
const PAYEE = "0x2222222222222222222222222222222222222222";

const sessionKey = privateKeyToAccount(generatePrivateKey());

let api: FakeApi;

beforeAll(async () => {
  api = await startFakeApi({
    sessions: [{ id: SES, address: sessionKey.address, accountId: ACCT }],
    accounts: [{ id: ACCT }],
    denyAbove: "500.00",
    approvalAbove: "100.00",
  });
});

afterAll(async () => {
  await api.close();
});

function agent(overrides: Partial<AgentClientOptions> = {}): AgentClient {
  return new AgentClient({
    baseUrl: api.url,
    accountId: ACCT,
    session: { id: SES, signer: sessionKey },
    validateResponses: true,
    retry: { baseDelayMs: 1, maxDelayMs: 2 },
    ...overrides,
  });
}

describe("agent request signing (RFC 9421, verified by core's verifyRequest)", () => {
  it("signs GETs and bodies; the fake API verifies digest, idempotency key and nonce", async () => {
    const client = agent();
    const balances = await client.balance();
    expect(balances.available).toBe("120.50");
    const get = api.requests.at(-1);
    expect(get?.auth).toBe("agent");
    expect(parseSignatureInput(get?.headers["signature-input"] ?? "").params.components).toEqual([
      "@method",
      "@target-uri",
    ]);

    await client.requestPayment({ amount: "3", memo: "invoice 7" });
    const post = api.requests.at(-1);
    expect(post?.auth).toBe("agent");
    const params = parseSignatureInput(post?.headers["signature-input"] ?? "").params;
    expect(params.components).toEqual(["@method", "@target-uri", "content-digest", "idempotency-key"]);
    expect(params.keyid).toBe(SES);
    expect(params.alg).toBe("eip191-secp256k1");
    expect(params.expires - params.created).toBe(120);
    expect(JSON.parse(post?.body ?? "{}").amount).toEqual({ amount: "3.00", asset: "USDC" });
  });

  it("re-signs every retry with a fresh nonce and the same idempotency key", async () => {
    const client = agent();
    api.inject({
      status: 503,
      problem: { code: "cosigner_unavailable", status: 503, title: "x", type: "x" },
    });
    const payment = await client.pay({ to: PAYEE, amount: "1.25", memo: "retry me" });
    expect(payment.status).toBe("submitted");
    const creates = api.requests.filter((r) => r.method === "POST" && r.url === "/v1/payments");
    const lastTwo = creates.slice(-2);
    expect(lastTwo).toHaveLength(2);
    expect(lastTwo[0]?.headers["idempotency-key"]).toBe(lastTwo[1]?.headers["idempotency-key"]);
    const nonces = lastTwo.map((r) => parseSignatureInput(r.headers["signature-input"] ?? "").params.nonce);
    expect(nonces[0]).not.toBe(nonces[1]);
    expect([...api.payments.values()].filter((p) => p.memo === "retry me")).toHaveLength(1);
  });

  it("is rejected when signed by a key that is not the session key", async () => {
    const intruder = agent({ session: { id: SES, signer: privateKeyToAccount(generatePrivateKey()) } });
    const error = await intruder.balance().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).code).toBe("signature_invalid");
  });
});

describe("two-step payments", () => {
  it("creates, signs the user operation hash with the session key, submits and waits for settlement", async () => {
    const client = agent();
    const payment = await client.pay(
      { to: PAYEE, amount: "12.5", memo: "dataset purchase" },
      { waitForSettlement: true, intervalMs: 5 },
    );
    expect(payment.status).toBe("settled");
    expect(payment.amount).toEqual({ amount: "12.50", asset: "USDC" });
    expect(payment.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    const submit = api.requests.find((r) => r.url === `/v1/payments/${payment.id}/signature`);
    expect(JSON.parse(submit?.body ?? "{}").session_id).toBe(SES);
    expect(submit?.headers["idempotency-key"]).toMatch(new RegExp(`^sig_${payment.id}_`));
  });

  it("throws PolicyDeniedError with the rule hits when policy denies", async () => {
    const error = await agent()
      .pay({ to: PAYEE, amount: "900.00" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyDeniedError);
    const denied = error as PolicyDeniedError;
    expect(denied.code).toBe("policy_denied");
    expect(denied.decision?.rule_hits[0]?.rule).toBe("limits.per_tx");
    expect(denied.message).toContain("limits.per_tx");
    expect(denied.resource?.object).toBe("payment");
  });

  it("returns requires_approval payments without signing", async () => {
    const before = api.requests.length;
    const payment = await agent().pay({ to: "agt_01JABCDEFGHJKMNPQRSTVWXYZ0", amount: "150.00" });
    expect(payment.status).toBe("requires_approval");
    expect(payment.counterparty.agent_id).toBe("agt_01JABCDEFGHJKMNPQRSTVWXYZ0");
    expect(api.requests.slice(before).some((r) => r.url.endsWith("/signature"))).toBe(false);
  });

  it("surfaces on-chain failures as PaymentFailedError", async () => {
    const failing = await startFakeApi({
      sessions: [{ id: SES, address: sessionKey.address, accountId: ACCT }],
      failOnChain: true,
    });
    try {
      const client = agent({ baseUrl: failing.url });
      const error = await client
        .pay({ to: PAYEE, amount: "1.00" }, { waitForSettlement: true, intervalMs: 5 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PaymentFailedError);
      expect((error as PaymentFailedError).code).toBe("chain_error");
      expect((error as Error).message).toContain("user operation reverted");
    } finally {
      await failing.close();
    }
  });

  it("rejects malformed amounts and targets before calling the API", async () => {
    const before = api.requests.length;
    const client = agent();
    await expect(client.pay({ to: PAYEE, amount: "1.0000001" })).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(client.pay({ to: PAYEE, amount: 5 as unknown as string })).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    await expect(client.pay({ to: "bob", amount: "1.00" })).rejects.toBeInstanceOf(InvalidRequestError);
    expect(api.requests.length).toBe(before);
  });

  it("dry-runs spends and lists transactions", async () => {
    const client = agent();
    const allowed = await client.checkSpend({ amount: "10.00", to: PAYEE });
    expect(allowed.outcome).toBe("allow");
    const denied = await client.checkSpend({ amount: "600", x402Domain: "API.Example.com" });
    expect(denied.outcome).toBe("deny");
    const check = api.requests.at(-1);
    expect(JSON.parse(check?.body ?? "{}").intent).toMatchObject({
      kind: "x402",
      x402_domain: "api.example.com",
    });
    const page = await client.listTransactions({ limit: 2 });
    expect(page.data.length).toBeLessThanOrEqual(2);
    expect(page.data.every((p) => p.account_id === ACCT)).toBe(true);
  });
});

describe("escrows and streams", () => {
  it("locks an escrow (sign → submit → locked) and releases it", async () => {
    const client = agent();
    const escrow = await client.createEscrow(
      { payee: PAYEE, amount: "40.00", expiresInSeconds: 3600, terms: "deliver the report" },
      { waitForSettlement: true, intervalMs: 5 },
    );
    expect(escrow.status).toBe("locked");
    expect(escrow.terms_hash).toMatch(/^0x/);
    const released = await client.releaseEscrow(escrow.id);
    expect(released.status).toBe("released");
    const signatures = api.requests.filter((r) => r.url === `/v1/escrows/${escrow.id}/signature`);
    expect(signatures).toHaveLength(2);
  });

  it("starts a stream", async () => {
    const stream = await agent().createStream({
      payee: "agt_01JABCDEFGHJKMNPQRSTVWXYZ0",
      amountPerInterval: "0.001",
      intervalSeconds: 1,
      deposit: "10",
    });
    expect(stream.status).toBe("active");
    expect(stream.deposit).toEqual({ amount: "10.00", asset: "USDC" });
  });

  it("signs only operations that are pending, and only before they expire", async () => {
    const client = agent();
    const escrow = await client.createEscrow({ payee: PAYEE, amount: "5.00" });
    expect(escrow.pending_action).toBeNull();
    expect(escrow.signing_request).toBeNull();

    // A leftover signing request without a pending action is never signed.
    const before = api.requests.length;
    const stale = {
      ...escrow,
      signing_request: {
        session_id: SES,
        user_op_hash: `0x${"ab".repeat(32)}`,
        chain_id: 84532,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    await expect(client.completeEscrow(stale)).resolves.toBe(stale);
    expect(api.requests.length).toBe(before);

    // An expired request for a pending action is refused rather than signed.
    const expired = {
      ...stale,
      pending_action: "release" as const,
      signing_request: { ...stale.signing_request, expires_at: new Date(Date.now() - 1000).toISOString() },
    };
    const error = await client.completeEscrow(expired).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("invalid_state");
    expect(api.requests.length).toBe(before);
  });

  it("completes a stream whose create operation was never signed (crash recovery)", async () => {
    const client = agent();
    const created = await client.streams.create({
      account_id: ACCT,
      payee: { address: PAYEE },
      amount_per_interval: { amount: "0.01", asset: "USDC" },
      interval_seconds: 60,
      deposit: { amount: "5.00", asset: "USDC" },
    });
    expect(created.pending_action).toBe("create");
    const completed = await client.completeStream(created.id);
    expect(completed.status).toBe("active");
    expect(completed.pending_action).toBeNull();
  });

  it("refuses account ids as escrow payees", async () => {
    await expect(agent().createEscrow({ payee: ACCT, amount: "1.00" })).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });
});
