import {
  ConnectionError,
  InsufficientFundsError,
  PolicyDeniedError,
  ProofError,
  TimeoutError,
  X402Error,
} from "@agentbank/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentBankMcpServer, TOOL_NAMES, type AgentBankMcpServerOptions } from "../src";
import {
  decision,
  fetchResult,
  mockBackend,
  NULLIFIER,
  payment,
  proofRequest,
  reservation,
} from "./fixtures";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(options: AgentBankMcpServerOptions = {}) {
  const backend = mockBackend();
  const server = createAgentBankMcpServer(backend, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { backend, client, call };
}

function errorOf(result: CallToolResult): { code: string; detail: string; [k: string]: unknown } {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const text = (result.content[0] as { text: string }).text;
  return (JSON.parse(text) as { error: { code: string; detail: string } }).error;
}

describe("tool catalog", () => {
  it("exposes exactly the ten tools with schemas and descriptions", async () => {
    const { client } = await connect({ maxX402PerCall: "0.25" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(60);
      expect(tool.outputSchema).toBeDefined();
    }
    const pay = tools.find((t) => t.name === "pay");
    const amount = (pay?.inputSchema.properties as Record<string, { type?: string; pattern?: string }>)
      .amount;
    expect(amount?.type).toBe("string");
    expect(amount?.pattern).toBeDefined();
    expect(pay?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(tools.find((t) => t.name === "get_balance")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "fetch_paid_resource")?.description).toContain("0.25 USDC");
    const names = tools.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/withdraw|policy|limit|unfreeze|session|disclose|settings/);

    // prove_claims changes nothing but discloses facts to a third party; reserving holds funds.
    const prove = tools.find((t) => t.name === "prove_claims");
    expect(prove?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(prove?.description).toMatch(/pseudonym/);
    expect(prove?.description).toMatch(/does not learn which agent/);
    expect(prove?.description).toMatch(/narrow the values down/);
    const reserve = tools.find((t) => t.name === "reserve_funds_for_proof");
    expect(reserve?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(reserve?.description).toMatch(/cannot spend the funds/);
    expect(tools.find((t) => t.name === "fetch_paid_resource")?.description).toContain(
      "AGENT-PROOF-REQUIRED",
    );
  });

  it("gives the model usage instructions", async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toContain("decimal strings");
  });
});

describe("tools", () => {
  it("get_balance returns structured balances", async () => {
    const { call } = await connect();
    const result = await call("get_balance");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      available: "120.50",
      spend_float: "5.00",
      asset: "USDC",
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
  });

  it("check_spend maps the intent and reports the decision", async () => {
    const { call, backend } = await connect();
    backend.checkSpend.mockResolvedValueOnce(decision("deny"));
    const result = await call("check_spend", {
      amount: "250.00",
      to_agent_id: "agt_01JABCDEFGHJKMNPQRSTVWXYZ0",
    });
    expect(backend.checkSpend).toHaveBeenCalledWith({
      amount: "250.00",
      to: "agt_01JABCDEFGHJKMNPQRSTVWXYZ0",
    });
    expect(result.structuredContent).toMatchObject({ allowed: false, outcome: "deny", policy_version: 4 });
    const both = await call("check_spend", {
      amount: "1",
      to_agent_id: "agt_01JABCDEFGHJKMNPQRSTVWXYZ0",
      to_address: "0x2222222222222222222222222222222222222222",
    });
    expect(errorOf(both).code).toBe("invalid_request");
  });

  it("pay sends exactly one recipient, waits for settlement and passes the idempotency key", async () => {
    const { call, backend } = await connect({ settlementTimeoutMs: 5_000 });
    const result = await call("pay", {
      amount: "2.50",
      to_address: "0x2222222222222222222222222222222222222222",
      memo: "dataset",
      idempotency_key: "llm-retry-0001",
    });
    expect(backend.pay).toHaveBeenCalledWith(
      { to: "0x2222222222222222222222222222222222222222", amount: "2.50", memo: "dataset" },
      { waitForSettlement: true, timeoutMs: 5_000, idempotencyKey: "llm-retry-0001" },
    );
    expect(result.structuredContent).toMatchObject({
      payment_id: "pay_01JABCDEFGHJKMNPQRSTVWXYZ0",
      status: "settled",
      amount: { amount: "2.50", asset: "USDC" },
      message: "Payment settled on-chain.",
    });

    backend.pay.mockResolvedValueOnce(
      payment({ status: "requires_approval", tx_hash: null, settled_at: null }),
    );
    const pending = await call("pay", { amount: "150", to_account_id: "acct_01JABCDEFGHJKMNPQRSTVWXYZ1" });
    expect((pending.structuredContent as { message: string }).message).toContain("human approver");

    expect(errorOf(await call("pay", { amount: "1" })).detail).toContain("exactly one");
  });

  it("rejects numeric amounts and malformed ids at the schema level", async () => {
    const { call, backend } = await connect();
    const numeric = await call("pay", {
      amount: 2.5,
      to_address: "0x2222222222222222222222222222222222222222",
    });
    expect(numeric.isError).toBe(true);
    expect((numeric.content[0] as { text: string }).text).toMatch(/Input validation error/);
    const precise = await call("pay", {
      amount: "1.0000001",
      to_address: "0x2222222222222222222222222222222222222222",
    });
    expect(precise.isError).toBe(true);
    const badId = await call("release_escrow", { escrow_id: "pay_01JABCDEFGHJKMNPQRSTVWXYZ0" });
    expect(badId.isError).toBe(true);
    expect(backend.pay).not.toHaveBeenCalled();
    expect(backend.releaseEscrow).not.toHaveBeenCalled();
  });

  it("returns API problems as tool errors with code and detail, never stack traces", async () => {
    const { call, backend } = await connect();
    backend.pay.mockRejectedValueOnce(
      new PolicyDeniedError(
        "policy_denied",
        "Payment pay_1 was denied (limits.per_day: daily cap 200.00)",
        {},
        {
          decision: decision("deny"),
        },
      ),
    );
    const denied = errorOf(
      await call("pay", { amount: "300", to_address: "0x2222222222222222222222222222222222222222" }),
    );
    expect(denied).toEqual({
      code: "policy_denied",
      detail: "Payment pay_1 was denied (limits.per_day: daily cap 200.00)",
      rule_hits: [{ rule: "limits.per_day", detail: "daily cap 200.00" }],
    });

    backend.pay.mockRejectedValueOnce(
      new InsufficientFundsError("insufficient_funds", "Available 1.00 < 5.01"),
    );
    expect(
      errorOf(await call("pay", { amount: "5", to_address: "0x2222222222222222222222222222222222222222" })),
    ).toEqual({
      code: "insufficient_funds",
      detail: "Available 1.00 < 5.01",
    });

    backend.balance.mockRejectedValueOnce(new TimeoutError("internal", "getBalances timed out"));
    expect(errorOf(await call("get_balance")).code).toBe("timeout");
    backend.balance.mockRejectedValueOnce(
      new ConnectionError("internal", "Could not reach Agent Bank at http://10.0.0.5"),
    );
    const network = errorOf(await call("get_balance"));
    expect(network.code).toBe("network_error");
    expect(network.detail).not.toContain("10.0.0.5");

    const secret = new Error("boom at /home/me/.agentbank/keys 0xdeadbeef");
    secret.stack = "Error: boom\n    at secretFunction (/srv/app.js:1:1)";
    backend.balance.mockRejectedValueOnce(secret);
    const unexpected = await call("get_balance");
    const text = (unexpected.content[0] as { text: string }).text;
    expect(errorOf(unexpected)).toEqual({
      code: "internal",
      detail: "Unexpected error while handling the request.",
    });
    expect(text).not.toMatch(/secretFunction|deadbeef|\.agentbank/);
  });

  it("fetch_paid_resource enforces the per-call cap and returns the paid response", async () => {
    const { call, backend } = await connect({ maxX402PerCall: "0.50" });
    const result = await call("fetch_paid_resource", {
      url: "https://api.example-data.com/weather?city=lisbon",
    });
    expect(backend.fetchWithPayment).toHaveBeenCalledWith(
      "https://api.example-data.com/weather?city=lisbon",
      { method: "GET" },
      { maxAmountPerRequest: "0.50" },
    );
    expect(result.structuredContent).toMatchObject({
      status: 200,
      paid: true,
      amount_paid: "0.01",
      transaction: `0x${"cd".repeat(32)}`,
      content_type: "application/json",
      body: '{"temp":21}',
      truncated: false,
    });

    await call("fetch_paid_resource", { url: "https://a.test/x", max_amount: "0.05" });
    expect(backend.fetchWithPayment.mock.calls.at(-1)?.[2]).toEqual({ maxAmountPerRequest: "0.05" });
    await call("fetch_paid_resource", { url: "https://a.test/x", max_amount: "25.00" });
    expect(backend.fetchWithPayment.mock.calls.at(-1)?.[2]).toEqual({ maxAmountPerRequest: "0.50" });

    await call("fetch_paid_resource", {
      url: "https://a.test/x",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"q":1}',
    });
    expect(backend.fetchWithPayment.mock.calls.at(-1)?.[1]).toEqual({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"q":1}',
    });
  });

  it("fetch_paid_resource truncates text, summarizes binary bodies and validates input", async () => {
    const { call, backend } = await connect({ maxResponseChars: 10 });
    backend.fetchWithPayment.mockResolvedValueOnce(
      fetchResult({
        paid: false,
        response: new Response("abcdefghijklmnop", { headers: { "content-type": "text/plain" } }),
      }),
    );
    const text = await call("fetch_paid_resource", { url: "https://a.test/free" });
    expect(text.structuredContent).toMatchObject({
      body: "abcdefghij",
      truncated: true,
      paid: false,
      amount_paid: null,
    });

    backend.fetchWithPayment.mockResolvedValueOnce(
      fetchResult({
        response: new Response(new Uint8Array(42), { headers: { "content-type": "image/png" } }),
      }),
    );
    const binary = await call("fetch_paid_resource", { url: "https://a.test/img" });
    expect((binary.structuredContent as { body: string }).body).toBe("[42 bytes of image/png omitted]");

    expect(errorOf(await call("fetch_paid_resource", { url: "file:///etc/passwd" })).code).toBe(
      "invalid_request",
    );
    expect(errorOf(await call("fetch_paid_resource", { url: "https://a.test", body: "x" })).detail).toContain(
      "GET",
    );

    backend.fetchWithPayment.mockRejectedValueOnce(
      new X402Error("amount_exceeds_limit", "Price 2.00 USDC exceeds maxAmountPerRequest 1.00 USDC"),
    );
    expect(errorOf(await call("fetch_paid_resource", { url: "https://a.test/premium" }))).toEqual({
      code: "policy_denied",
      detail: "Price 2.00 USDC exceeds maxAmountPerRequest 1.00 USDC",
      reason: "amount_exceeds_limit",
    });
  });

  it("request_payment, create_escrow, release_escrow and list_transactions", async () => {
    const { call, backend } = await connect();
    const request = await call("request_payment", { amount: "3.00", memo: "invoice 7", reference: "INV-7" });
    expect(backend.requestPayment).toHaveBeenCalledWith({
      amount: "3.00",
      memo: "invoice 7",
      reference: "INV-7",
    });
    expect(request.structuredContent).toMatchObject({
      payment_request_id: "preq_01JABCDEFGHJKMNPQRSTVWXYZ0",
      status: "open",
    });

    const escrow = await call("create_escrow", {
      amount: "40",
      payee_agent_id: "agt_01JABCDEFGHJKMNPQRSTVWXYZ0",
      expires_in_hours: 48,
      terms: "deliver the report",
    });
    expect(backend.createEscrow).toHaveBeenCalledWith(
      {
        payee: "agt_01JABCDEFGHJKMNPQRSTVWXYZ0",
        amount: "40",
        expiresInSeconds: 172_800,
        terms: "deliver the report",
      },
      expect.objectContaining({ waitForSettlement: true }),
    );
    expect(escrow.structuredContent).toMatchObject({
      escrow_id: "esc_01JABCDEFGHJKMNPQRSTVWXYZ0",
      status: "locked",
      pending_action: null,
    });
    expect(errorOf(await call("create_escrow", { amount: "1" })).detail).toContain("exactly one");
    expect(
      errorOf(
        await call("create_escrow", {
          amount: "1",
          payee_address: "0x2222222222222222222222222222222222222222",
          release: "arbiter",
        }),
      ).detail,
    ).toContain("arbiter");

    const released = await call("release_escrow", { escrow_id: "esc_01JABCDEFGHJKMNPQRSTVWXYZ0" });
    expect(released.structuredContent).toMatchObject({ status: "released", pending_action: null });

    const list = await call("list_transactions", { limit: 2, status: "settled" });
    expect(backend.listTransactions).toHaveBeenCalledWith({ limit: 2, status: "settled" });
    const structured = list.structuredContent as {
      transactions: { payment_id: string }[];
      next_cursor: string;
    };
    expect(structured.transactions).toHaveLength(2);
    expect(structured.next_cursor).toBe("c2");
  });
});

describe("private-proof tools", () => {
  it("prove_claims proves a request object or a header value and returns the AGENT-PROOF header", async () => {
    const { call, backend } = await connect();
    const result = await call("prove_claims", { request: proofRequest() });
    expect(result.isError).toBeFalsy();
    expect(backend.proofs.answer).toHaveBeenCalledWith(proofRequest(), {});
    expect(result.structuredContent).toMatchObject({
      scope: "api.seller.example",
      header_name: "AGENT-PROOF",
      header_value: "eyJyZXF1ZXN0Ijp7fX0=",
      nullifier: NULLIFIER,
      expires_at: "2025-10-09T08:58:20.000Z",
      constrained: ["principal_verification", "per_tx_limit"],
      presentation: { type: "agentbank.proof.v1", nullifier: NULLIFIER },
    });

    await call("prove_claims", {
      challenge: "eyJ0eXBlIjoiYWdlbnRiYW5rIn0=",
      reservation_id: "prv_01JABCDEFGHJKMNPQRSTVWXYZ0",
    });
    expect(backend.proofs.answer).toHaveBeenLastCalledWith("eyJ0eXBlIjoiYWdlbnRiYW5rIn0=", {
      reservationId: "prv_01JABCDEFGHJKMNPQRSTVWXYZ0",
    });
    expect(errorOf(await call("prove_claims", {})).detail).toContain("exactly one");
    expect(
      errorOf(await call("prove_claims", { request: proofRequest(), challenge: "eyJ9" })).detail,
    ).toContain("exactly one");
  });

  it("prove_claims refuses clearly without a proof secret, and explains refusals", async () => {
    const { call, backend } = await connect();
    backend.proofs.canProve = false;
    const missing = errorOf(await call("prove_claims", { request: proofRequest() }));
    expect(missing).toMatchObject({ code: "invalid_request", reason: "proof_secret_missing" });
    expect(missing.detail).toContain("AGENTBANK_PROOF_SECRET");
    expect(backend.proofs.answer).not.toHaveBeenCalled();

    backend.proofs.canProve = true;
    backend.proofs.answer.mockRejectedValueOnce(
      new ProofError("reservation_required", "reserve first", {
        reservationNeeded: {
          amount: "500.00",
          scope: "api.seller.example",
          scopeTag: "7",
          until: 1_760_003_600,
        },
      }),
    );
    expect(errorOf(await call("prove_claims", { request: proofRequest() }))).toEqual({
      code: "invalid_state",
      detail: "reserve first",
      reason: "reservation_required",
      reservation_needed: {
        amount: "500.00",
        scope: "api.seller.example",
        scope_tag: "7",
        until: "2025-10-09T09:53:20.000Z",
      },
    });
    backend.proofs.answer.mockRejectedValueOnce(
      new ProofError("undisclosed", "not disclosed", {
        attributes: ["balance"],
        undisclosedClasses: ["balance"],
      }),
    );
    expect(errorOf(await call("prove_claims", { request: proofRequest() }))).toMatchObject({
      reason: "undisclosed",
      attributes: ["balance"],
      undisclosed_classes: ["balance"],
    });
    backend.proofs.answer.mockRejectedValueOnce(
      new ProofError("rate_limited", "slow down", { retryAfterMs: 1_500 }),
    );
    expect(errorOf(await call("prove_claims", { request: proofRequest() }))).toMatchObject({
      code: "rate_limited",
      retry_after_seconds: 2,
    });
  });

  it("reserve_funds_for_proof holds funds for one verifier", async () => {
    const { call, backend } = await connect();
    const result = await call("reserve_funds_for_proof", {
      amount: "500.00",
      scope: "api.seller.example",
      expires_in_seconds: 3_600,
      idempotency_key: "reserve-0001",
    });
    expect(backend.proofs.reserve).toHaveBeenCalledWith(
      { amount: "500.00", scope: "api.seller.example", forSeconds: 3_600 },
      { idempotencyKey: "reserve-0001" },
    );
    expect(result.structuredContent).toMatchObject({
      reservation_id: "prv_01JABCDEFGHJKMNPQRSTVWXYZ0",
      status: "pending",
      amount: { amount: "500.00", asset: "USDC" },
      scope_tag: "1311768467463790320",
    });
    expect((result.structuredContent as { message: string }).message).toContain("next attested root");

    backend.proofs.reserve.mockResolvedValueOnce(reservation({ status: "active" }));
    const active = await call("reserve_funds_for_proof", {
      amount: "1",
      scope: "api.seller.example",
      expires_in_seconds: 120,
    });
    expect(backend.proofs.reserve).toHaveBeenLastCalledWith(
      { amount: "1", scope: "api.seller.example", forSeconds: 120 },
      undefined,
    );
    expect((active.structuredContent as { message: string }).message).toContain("provable now");

    const tooLong = await call("reserve_funds_for_proof", {
      amount: "1",
      scope: "api.seller.example",
      expires_in_seconds: 604_801,
    });
    expect(tooLong.isError).toBe(true);
    const tooShort = await call("reserve_funds_for_proof", {
      amount: "1",
      scope: "api.seller.example",
      expires_in_seconds: 60,
    });
    expect(tooShort.isError).toBe(true);
    expect(backend.proofs.reserve).toHaveBeenCalledTimes(2);
  });

  it("fetch_paid_resource reports a presented proof and its nullifier, and proof refusals", async () => {
    const { call, backend } = await connect();
    backend.fetchWithPayment.mockResolvedValueOnce(
      fetchResult({ proofPresented: true, nullifier: NULLIFIER }),
    );
    const result = await call("fetch_paid_resource", { url: "https://api.seller.example/report" });
    expect(result.structuredContent).toMatchObject({
      status: 200,
      proof_presented: true,
      nullifier: NULLIFIER,
    });

    const plain = await call("fetch_paid_resource", { url: "https://a.test/x" });
    expect(plain.structuredContent).toMatchObject({ proof_presented: false, nullifier: null });

    backend.fetchWithPayment.mockRejectedValueOnce(
      new ProofError("proof_rejected", "The verifier refused the proof (root_revoked)", {
        verifierReason: "root_revoked",
      }),
    );
    expect(errorOf(await call("fetch_paid_resource", { url: "https://api.seller.example/report" }))).toEqual({
      code: "unauthorized",
      detail: "The verifier refused the proof (root_revoked)",
      reason: "proof_rejected",
      verifier_reason: "root_revoked",
    });
  });
});
