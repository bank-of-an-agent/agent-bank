import { erc20Abi, type ChainGateway, type SettleAuthorizationInput } from "@agentbank/chain";
import { newId, usdc } from "@agentbank/core";
import { routes } from "@agentbank/core/api";
import type { SqlClient } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";
import { encodeFunctionData, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorizationStore, type AuthorizationRow } from "../src/store";
import {
  buildPayment,
  createHarness,
  otherRelayer,
  otherSeller,
  overrideGateway,
  payer,
  relayer,
  seller,
  stranger,
  tamper,
  type BuiltPayment,
  type Harness,
} from "./helpers";

let db: SqlClient;
let store: AuthorizationStore;

beforeAll(async () => {
  db = await createTestDatabase();
  store = new AuthorizationStore(db);
});

afterAll(async () => {
  await db.close();
});

function funded(options: Parameters<typeof createHarness>[1] = {}): Harness {
  const h = createHarness(db, options);
  h.chain.faucet(payer.address, usdc("100"));
  if (options.automine === false) h.chain.mine();
  return h;
}

async function rowOf(h: Harness, built: BuiltPayment): Promise<AuthorizationRow | undefined> {
  return store.findByKey({
    chainId: 1337,
    asset: h.asset.address,
    authorizer: payer.address,
    nonce: built.authorization.nonce,
  });
}

async function rowsForNonce(nonce: Hex): Promise<number> {
  const { rows } = await db.query<{ n: bigint }>(
    "SELECT count(*)::bigint AS n FROM x402_authorization WHERE nonce = $1",
    [nonce.toLowerCase()],
  );
  return Number(rows[0]?.n ?? 0n);
}

function drainCall(h: Harness, amount: bigint) {
  return {
    from: payer.address,
    to: h.asset.address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [stranger.address, amount] }),
  };
}

function settleInput(
  h: Harness,
  built: BuiltPayment,
  extra: Partial<SettleAuthorizationInput> = {},
): SettleAuthorizationInput {
  return { token: h.asset.address, ...built.authorization, signature: built.signature, ...extra };
}

describe("settle: a valid EOA payment", () => {
  it("relays transferWithAuthorization, moves the funds and records the authorization", async () => {
    const h = funded();
    const built = await buildPayment(h, { amount: usdc("2.50") });
    const before = { payer: h.chain.balanceOf(payer.address), seller: h.chain.balanceOf(seller) };

    const out = await h.facilitator.settle(built.body);

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      success: true,
      payer: payer.address,
      network: "eip155:1337",
      amount: "2500000",
    });
    expect(out.body.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(routes.x402Settle.response.parse(out.body)).toEqual(out.body);
    expect(h.chain.balanceOf(payer.address)).toBe(before.payer - usdc("2.50"));
    expect(h.chain.balanceOf(seller)).toBe(before.seller + usdc("2.50"));
    expect(
      await h.chain.gateway.authorizationState(h.asset.address, payer.address, built.authorization.nonce),
    ).toBe(true);

    const tx = h.chain.transaction(out.body.transaction as Hex);
    expect(tx?.success).toBe(true);
    expect(tx?.logs.map((l) => l.eventName).sort()).toEqual(["AuthorizationUsed", "Transfer"]);

    const row = await rowOf(h, built);
    expect(row).toMatchObject({
      status: "settled",
      tx_hash: out.body.transaction,
      scheme: "exact",
      chain_id: 1337,
      asset: h.asset.address,
      authorizer: payer.address,
      pay_to: seller,
      amount: usdc("2.50"),
      relayer: relayer.address,
      payee_account_id: null,
      resource_url: "https://seller.example/weather",
      failure_reason: null,
    });
    expect(row?.id).toMatch(/^x4p_/);
    expect(row?.block_number).toBe(tx?.blockNumber);
    expect(row?.settled_at).toBeInstanceOf(Date);
  });

  it("records the Agent Bank account when payTo is a registered x402 payee", async () => {
    const h = funded();
    const orgId = newId("org");
    const agentId = newId("agent");
    const accountId = newId("account");
    await db.query(
      "INSERT INTO org (id, legal_name, kind, country, contact_email, owner_address) VALUES ($1, 'Seller Co', 'company', 'US', 'ops@seller.example', $2)",
      [orgId, stranger.address],
    );
    await db.query("INSERT INTO agent (id, org_id, name) VALUES ($1, $2, 'weather-seller')", [
      agentId,
      orgId,
    ]);
    await db.query(
      "INSERT INTO account (id, org_id, agent_id, role, chain_id, address, owner_address, salt) VALUES ($1, $2, $3, 'agent', 1337, $4, $5, '1')",
      [accountId, orgId, agentId, otherSeller, stranger.address],
    );
    await db.query("INSERT INTO x402_payee (account_id, domains) VALUES ($1, $2)", [
      accountId,
      ["seller.example"],
    ]);

    const built = await buildPayment(h, { payTo: otherSeller });
    const out = await h.facilitator.settle(built.body);
    expect(out.body.success).toBe(true);
    const row = await store.findByKey({
      chainId: 1337,
      asset: h.asset.address,
      authorizer: payer.address,
      nonce: built.authorization.nonce,
    });
    expect(row?.payee_account_id).toBe(accountId);
    expect(row?.pay_to).toBe(otherSeller);
  });
});

describe("settle: single use, replay and idempotency", () => {
  it("rejects a replay after settlement: verify refuses it and nothing moves twice", async () => {
    const h = funded();
    const built = await buildPayment(h);
    const settled = await h.facilitator.settle(built.body);
    expect(settled.body.success).toBe(true);
    const after = h.chain.balanceOf(seller);

    const replay = await h.facilitator.verify(built.body);
    expect(replay.body).toMatchObject({ isValid: false, invalidReason: "authorization_already_used" });
    expect(replay.body.invalidMessage).toContain(settled.body.transaction);
    expect(h.chain.balanceOf(seller)).toBe(after);
  });

  it("refuses the same authorization presented with other requirements", async () => {
    const h = funded();
    const built = await buildPayment(h);
    expect((await h.facilitator.settle(built.body)).body.success).toBe(true);
    const other = tamper(built.body, (b) => {
      b.paymentRequirements.payTo = otherSeller;
      b.paymentPayload.accepted.payTo = otherSeller;
    });
    const out = await h.facilitator.settle(other);
    expect(out.body).toMatchObject({
      success: false,
      errorReason: "authorization_already_used",
      transaction: "",
    });
    expect(h.chain.balanceOf(otherSeller)).toBe(0n);
  });

  it("is idempotent: settling a settled authorization returns the original transaction", async () => {
    const h = funded();
    const built = await buildPayment(h, { amount: usdc("1.25") });
    const first = await h.facilitator.settle(built.body);
    const second = await h.facilitator.settle(built.body);
    expect(second).toEqual(first);
    expect(h.chain.balanceOf(seller)).toBe(usdc("1.25"));
    expect(await rowsForNonce(built.authorization.nonce)).toBe(1);

    // Even after the authorization's validity window closed.
    h.clock.advanceSeconds(3_600);
    expect(await h.facilitator.settle(built.body)).toEqual(first);
    const emf = h.emf.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(emf.map((l) => [l.outcome, l.Settlements])).toEqual([
      ["settled", 1],
      ["replayed", 0],
      ["replayed", 0],
    ]);
  });

  it("re-runs every verification check before settling", async () => {
    const h = funded();
    const bad = await buildPayment(h, { signer: stranger, from: payer.address });
    const out = await h.facilitator.settle(bad.body);
    expect(out.body).toMatchObject({
      success: false,
      errorReason: "invalid_exact_evm_payload_signature",
      transaction: "",
      network: "eip155:1337",
    });
    expect(await rowsForNonce(bad.authorization.nonce)).toBe(0);

    // Valid at verify time, but the payer spent the float before settlement.
    const built = await buildPayment(h, { amount: usdc("60") });
    expect((await h.facilitator.verify(built.body)).body.isValid).toBe(true);
    h.chain.sendTransaction(drainCall(h, usdc("50")));
    const late = await h.facilitator.settle(built.body);
    expect(late.body).toMatchObject({ success: false, errorReason: "insufficient_funds" });
    expect(await rowsForNonce(built.authorization.nonce)).toBe(0);

    // Expired between verify and settle.
    const expiring = await buildPayment(h);
    expect((await h.facilitator.verify(expiring.body)).body.isValid).toBe(true);
    h.clock.advanceSeconds(58);
    expect((await h.facilitator.settle(expiring.body)).body.errorReason).toBe(
      "invalid_exact_evm_payload_authorization_valid_before",
    );
  });

  it("answers malformed settle bodies in the x402 shape with HTTP 400", async () => {
    const h = funded();
    const out = await h.facilitator.settle({ x402Version: 2 });
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({
      success: false,
      errorReason: "invalid_payload",
      transaction: "",
      network: "eip155:1337",
    });
    expect(routes.x402Settle.response.safeParse(out.body).success).toBe(true);
  });
});

describe("settle: failures are recorded and final", () => {
  it("marks the authorization failed when the relay reverts (dry run)", async () => {
    const h = funded({
      gateway: (gateway, chain) =>
        overrideGateway(gateway, {
          settleAuthorization: async (input) => {
            // The payer empties the float between our checks and the relay.
            chain.sendTransaction(drainCall(h, chain.balanceOf(payer.address)));
            return gateway.settleAuthorization(input);
          },
        }),
    });
    const built = await buildPayment(h);
    const out = await h.facilitator.settle(built.body);
    expect(out.body).toMatchObject({
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: "",
    });
    expect(out.body.errorMessage).toMatch(/transfer amount exceeds balance/);
    expect(h.chain.balanceOf(seller)).toBe(0n);

    const row = await rowOf(h, built);
    expect(row).toMatchObject({
      status: "failed",
      failure_reason: "invalid_transaction_state",
      tx_hash: null,
    });
    expect(row?.failure_detail).toMatch(/transfer amount exceeds balance/);

    // Single use: the failure is final for this authorization.
    const again = await h.facilitator.settle(built.body);
    expect(again.body).toMatchObject({ success: false, errorReason: "invalid_transaction_state" });
    expect((await h.facilitator.verify(built.body)).body).toMatchObject({
      isValid: false,
      invalidReason: "authorization_already_used",
    });
  });

  it("marks the authorization failed when the transaction reverts on-chain", async () => {
    const h = funded({
      automine: false,
      gateway: (gateway, chain) =>
        overrideGateway(gateway, {
          settleAuthorization: async (input) => {
            chain.sendTransaction(drainCall(h, chain.balanceOf(payer.address))); // pending, ahead of ours
            const sent = await gateway.settleAuthorization(input); // dry run against the head: passes
            setTimeout(() => chain.mine(), 5);
            return sent;
          },
        }),
    });
    const built = await buildPayment(h);
    const out = await h.facilitator.settle(built.body);
    expect(out.body).toMatchObject({ success: false, errorReason: "invalid_transaction_state" });
    expect(out.body.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.chain.transaction(out.body.transaction as Hex)?.success).toBe(false);
    const row = await rowOf(h, built);
    expect(row).toMatchObject({
      status: "failed",
      tx_hash: out.body.transaction,
      failure_reason: "invalid_transaction_state",
    });
    const emf = JSON.parse(h.emf.at(-1) ?? "{}") as Record<string, unknown>;
    expect(emf).toMatchObject({ route: "settle", outcome: "failed", Settlements: 0, Failures: 1 });
  });
});

describe("settle: front-running (EIP-3009 is relayable by anyone)", () => {
  it("reports the payment as settled when another relayer submitted it first", async () => {
    let frontRunTx: Hex | undefined;
    const h = funded({
      gateway: (gateway) =>
        overrideGateway(gateway, {
          settleAuthorization: async (input) => {
            frontRunTx = (await gateway.settleAuthorization({ ...input, relayer: otherRelayer })).txHash;
            return gateway.settleAuthorization(input); // ours now fails its dry run
          },
        }),
    });
    const built = await buildPayment(h, { amount: usdc("3") });
    const out = await h.facilitator.settle(built.body);
    expect(out.body).toMatchObject({ success: true, transaction: frontRunTx });
    expect(h.chain.balanceOf(seller)).toBe(usdc("3"));
    expect(await rowOf(h, built)).toMatchObject({ status: "settled", tx_hash: frontRunTx });
  });

  it("recognizes a front-runner mined ahead of us in the same block", async () => {
    let frontRunTx: Hex | undefined;
    let ourTx: Hex | undefined;
    const h = funded({
      automine: false,
      gateway: (gateway, chain) =>
        overrideGateway(gateway, {
          settleAuthorization: async (input) => {
            frontRunTx = (await gateway.settleAuthorization({ ...input, relayer: otherRelayer })).txHash;
            const ours = await gateway.settleAuthorization(input);
            ourTx = ours.txHash;
            setTimeout(() => chain.mine(), 5);
            return ours;
          },
        }),
    });
    const built = await buildPayment(h);
    const out = await h.facilitator.settle(built.body);
    expect(out.body).toMatchObject({ success: true, transaction: frontRunTx });
    expect(h.chain.transaction(ourTx as Hex)?.success).toBe(false);
    expect(h.chain.transaction(frontRunTx as Hex)?.blockNumber).toBe(
      h.chain.transaction(ourTx as Hex)?.blockNumber,
    );
    expect(h.chain.balanceOf(seller)).toBe(usdc("0.01"));
  });

  it("does not report success when the nonce was used for a different payment", async () => {
    const h = funded({
      gateway: (gateway) =>
        overrideGateway(gateway, {
          settleAuthorization: async (input) => {
            // Same nonce, but used by an unrelated transfer to someone else: not this payment.
            const decoy = await buildPayment(h, { nonce: input.nonce, payTo: otherSeller });
            await gateway.settleAuthorization({
              token: h.asset.address,
              ...decoy.authorization,
              signature: decoy.signature,
            });
            return gateway.settleAuthorization(input);
          },
        }),
    });
    const built = await buildPayment(h);
    const out = await h.facilitator.settle(built.body);
    expect(out.body).toMatchObject({ success: false, errorReason: "invalid_transaction_state" });
    expect(h.chain.balanceOf(seller)).toBe(0n);
  });
});

describe("settle: unconfirmed and interrupted settlements", () => {
  it("answers settlement_pending when the receipt is late, then settles on retry", async () => {
    const h = funded({ automine: false, options: { receiptTimeoutMs: 30 } });
    const built = await buildPayment(h);
    const pending = await h.facilitator.settle(built.body);
    expect(pending.body).toMatchObject({ success: false, errorReason: "settlement_pending" });
    const txHash = pending.body.transaction as Hex;
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await rowOf(h, built)).toMatchObject({ status: "settling", tx_hash: txHash });

    // Still unmined: a retry reports the settlement in progress, with the transaction.
    const inProgress = await h.facilitator.settle(built.body);
    expect(inProgress.body).toMatchObject({
      success: false,
      errorReason: "settlement_in_progress",
      transaction: txHash,
    });
    expect((await h.facilitator.verify(built.body)).body.invalidReason).toBe("authorization_already_used");

    h.chain.mine();
    const done = await h.facilitator.settle(built.body);
    expect(done.body).toMatchObject({ success: true, transaction: txHash });
    expect(await rowOf(h, built)).toMatchObject({ status: "settled", tx_hash: txHash });
  });

  it("the sweep confirms late receipts without a retry", async () => {
    const h = funded({ automine: false, options: { receiptTimeoutMs: 20 } });
    const built = await buildPayment(h);
    const pending = await h.facilitator.settle(built.body);
    expect(pending.body.errorReason).toBe("settlement_pending");
    h.chain.mine();
    h.clock.advanceSeconds(61);
    const swept = await h.facilitator.sweepStale(60);
    expect(swept.settled).toBeGreaterThanOrEqual(1);
    expect(await rowOf(h, built)).toMatchObject({ status: "settled", tx_hash: pending.body.transaction });
  });

  it("keeps the claim when the submission outcome is unknown, and fails it once expired and unused", async () => {
    const h = funded({
      gateway: (gateway) =>
        overrideGateway(gateway, {
          settleAuthorization: async () => Promise.reject(new Error("socket hang up")),
        }),
    });
    const built = await buildPayment(h);
    const out = await h.facilitator.settle(built.body);
    expect(out.body).toMatchObject({ success: false, errorReason: "settlement_pending", transaction: "" });
    expect(await rowOf(h, built)).toMatchObject({ status: "settling", tx_hash: null });
    expect((await rowOf(h, built))?.failure_detail).toMatch(/socket hang up/);

    expect((await h.facilitator.settle(built.body)).body.errorReason).toBe("settlement_in_progress");

    h.clock.advanceSeconds(60 + 121);
    await h.facilitator.sweepStale(60, 500);
    expect(await rowOf(h, built)).toMatchObject({
      status: "failed",
      failure_reason: "invalid_transaction_state",
    });
    expect((await h.facilitator.settle(built.body)).body).toMatchObject({
      success: false,
      errorReason: "invalid_transaction_state",
    });
    expect(h.chain.balanceOf(seller)).toBe(0n);
  });

  it("recovers the transaction from the chain when bookkeeping was cut short after broadcast", async () => {
    let sent: Hex | undefined;
    const h = funded({
      gateway: (gateway: ChainGateway) =>
        overrideGateway(gateway, {
          settleAuthorization: async (input) => {
            sent = (await gateway.settleAuthorization(input)).txHash; // broadcast and mined...
            throw new Error("connection reset"); // ...but the answer never arrives
          },
        }),
    });
    const built = await buildPayment(h);
    expect((await h.facilitator.settle(built.body)).body.errorReason).toBe("settlement_pending");
    expect(await rowOf(h, built)).toMatchObject({ status: "settling", tx_hash: null });

    const retry = await h.facilitator.settle(built.body);
    expect(retry.body).toMatchObject({ success: true, transaction: sent });
    expect(await rowOf(h, built)).toMatchObject({ status: "settled", tx_hash: sent });
    expect(h.chain.balanceOf(seller)).toBe(usdc("0.01"));
  });

  it("settles directly through the gateway's relayer (relayed by another facilitator) are seen as used", async () => {
    const h = funded();
    const built = await buildPayment(h);
    await h.chain.gateway.settleAuthorization(settleInput(h, built, { relayer: otherRelayer }));
    const out = await h.facilitator.settle(built.body);
    expect(out.body).toMatchObject({ success: false, errorReason: "invalid_exact_evm_nonce_already_used" });
    expect(await rowsForNonce(built.authorization.nonce)).toBe(0);
  });
});
