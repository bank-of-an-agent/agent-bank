import { EARLY_WITHDRAWAL_TYPES } from "@agentbank/chain";
import { ownerPayloads, usdc } from "@agentbank/core";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pollReceipts } from "../src/domain/receipts";
import { triggerTopUps } from "../src/jobs/keepers";
import { agentCall, call, createHarness, ownerAuth, type Harness } from "./support/harness";
import { onboard, signOwnerOperation, type World } from "./support/flows";

let h: Harness;
let w: World;
const money = (amount: string) => ({ amount, asset: "USDC" });

beforeAll(async () => {
  h = await createHarness();
  const contracts = [h.chain.contracts.vaults].filter(Boolean);
  w = await onboard(h, { name: "saver", fund: usdc("300"), scope: { allowed_contracts: contracts } });
});
afterAll(async () => h.close());

describe("goal vaults (ledger only)", () => {
  it("lets agents deposit and only principals withdraw", async () => {
    const created = await agentCall(h, w.session, "POST", "/v1/vaults", {
      body: { account_id: w.account.id, kind: "goal", name: "GPU fund", target: money("200.00") },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: "goal",
      balance: money("0.00"),
      target: money("200.00"),
      contract_address: null,
    });
    const deposit = await agentCall(h, w.session, "POST", `/v1/vaults/${created.body.id}/deposit`, {
      body: { amount: money("50.00") },
    });
    expect(deposit.body.balance).toEqual(money("50.00"));
    const balances = await agentCall(h, w.session, "GET", `/v1/accounts/${w.account.id}/balances`);
    expect(balances.body).toMatchObject({ available: "250.00", savings: "50.00", total: "300.00" });
    expect(balances.body.vaults).toEqual([{ vault_id: created.body.id, name: "GPU fund", balance: "50.00" }]);

    const byAgent = await agentCall(h, w.session, "POST", `/v1/vaults/${created.body.id}/withdraw`, {
      body: { amount: money("10.00") },
    });
    expect(byAgent.status).toBe(403);
    const byPrincipal = await call(h.app, "POST", `/v1/vaults/${created.body.id}/withdraw`, {
      token: w.apiKey,
      body: { amount: money("20.00") },
    });
    expect(byPrincipal.body.balance).toEqual(money("30.00"));
    const overdraw = await call(h.app, "POST", `/v1/vaults/${created.body.id}/withdraw`, {
      token: w.apiKey,
      body: { amount: money("31.00") },
    });
    expect(overdraw.status).toBe(422);
    const list = await agentCall(h, w.session, "GET", "/v1/vaults");
    expect(list.body.data).toHaveLength(1);
  });
});

describe("locked vaults (TimeLockVaults)", () => {
  let vaultId: string;
  let unlockAt: Date;

  it("is created by the principal through an owner operation", async () => {
    unlockAt = new Date(h.clock.now().getTime() + 30 * 86_400_000);
    const byAgent = await agentCall(h, w.session, "POST", "/v1/vaults", {
      body: { account_id: w.account.id, kind: "locked", name: "Locked", unlock_at: unlockAt.toISOString() },
    });
    expect(byAgent.status).toBe(403);
    const created = await call(h.app, "POST", "/v1/vaults", {
      token: w.apiKey,
      body: { account_id: w.account.id, kind: "locked", name: "Locked", unlock_at: unlockAt.toISOString() },
    });
    expect(created.status).toBe(201);
    vaultId = created.body.id;
    const opId = created.headers["agentbank-owner-operation-id"] as string;
    expect(opId).toMatch(/^oop_/);
    const signed = await signOwnerOperation(h, w, opId);
    expect(signed.body.status).toBe("succeeded");
    const vault = await call(h.app, "GET", `/v1/vaults/${vaultId}`, { token: w.apiKey });
    expect(vault.body.onchain_id).toEqual(expect.any(String));
    expect(vault.body.contract_address).toBe(h.chain.contracts.vaults);
  });

  it("takes deposits signed by the owner key (agents cannot deposit into locked vaults)", async () => {
    const byAgent = await agentCall(h, w.session, "POST", `/v1/vaults/${vaultId}/deposit`, {
      body: { amount: money("40.00") },
    });
    expect(byAgent.status).toBe(403);
    const res = await call(h.app, "POST", `/v1/vaults/${vaultId}/deposit`, {
      token: w.apiKey,
      body: { amount: money("40.00") },
    });
    expect(res.status).toBe(200);
    const paymentId = res.headers["agentbank-payment-id"] as string;
    const opId = res.headers["agentbank-owner-operation-id"] as string;
    expect(paymentId).toMatch(/^pay_/);
    expect(res.body.pending_operation_id).toBe(opId);
    const payment = await call(h.app, "GET", `/v1/payments/${paymentId}`, { token: w.apiKey });
    expect(payment.body).toMatchObject({
      kind: "transfer",
      status: "requires_signature",
      fee: money("0.00"),
      owner_operation_id: opId,
      signing_request: { session_id: null },
    });
    const signed = await signOwnerOperation(h, w, opId);
    expect(signed.body.status).toBe("succeeded");
    const vault = await call(h.app, "GET", `/v1/vaults/${vaultId}`, { token: w.apiKey });
    expect(vault.body.pending_operation_id).toBeNull();
    expect(h.sim.getVault(BigInt(vault.body.onchain_id))?.balance).toBe(usdc("40"));
    // The reconciler posts the deposit from the vault's Deposited event.
    await h.indexer.sync();
    const settled = await call(h.app, "GET", `/v1/payments/${paymentId}`, { token: w.apiKey });
    expect(settled.body.status).toBe("settled");
    const after = await call(h.app, "GET", `/v1/vaults/${vaultId}`, { token: w.apiKey });
    expect(after.body.balance).toEqual(money("40.00"));
  });

  it("withdraws early only with the owner's EarlyWithdrawal signature", async () => {
    const challenge = await call(h.app, "POST", `/v1/vaults/${vaultId}/withdraw`, {
      token: w.apiKey,
      body: { amount: money("15.00") },
    });
    expect(challenge.status).toBe(403);
    expect(challenge.body.code).toBe("owner_signature_required");
    const typed = challenge.body.typed_data;
    expect(typed.primaryType).toBe("EarlyWithdrawal");
    const deadline = Math.floor(h.clock.now().getTime() / 1000) + 600;
    const signature = await w.owner.signTypedData({
      domain: { ...typed.domain, verifyingContract: typed.domain.verifyingContract as Hex },
      types: EARLY_WITHDRAWAL_TYPES,
      primaryType: "EarlyWithdrawal",
      message: {
        vaultId: BigInt(typed.message.vaultId),
        amount: usdc("15"),
        nonce: BigInt(typed.message.nonce),
        deadline: BigInt(deadline),
      },
    });
    const res = await call(h.app, "POST", `/v1/vaults/${vaultId}/withdraw`, {
      token: w.apiKey,
      body: {
        amount: money("15.00"),
        owner_authorization: {
          signer: w.owner.address,
          signature,
          issued_at: deadline - 600,
          expires_at: deadline,
        },
      },
    });
    expect(res.status).toBe(200);
    const signed = await signOwnerOperation(h, w, res.headers["agentbank-owner-operation-id"] as string);
    expect(signed.body.status).toBe("succeeded");
    const vault = await call(h.app, "GET", `/v1/vaults/${vaultId}`, { token: w.apiKey });
    expect(h.sim.getVault(BigInt(vault.body.onchain_id))?.balance).toBe(usdc("25"));
  });
});

describe("treasury, auto top-up, funds, sweep", () => {
  it("configures auto top-up with an owner operation and triggers the keeper", async () => {
    const treasury = await call(h.app, "POST", "/v1/orgs/me/treasury-accounts", {
      token: w.apiKey,
      body: { chain: "simulated" },
    });
    expect(treasury.status).toBe(201);
    expect(treasury.body).toMatchObject({ role: "treasury", agent_id: null });
    const me = await call(h.app, "GET", "/v1/orgs/me", { token: w.apiKey });
    expect(me.body.treasury_account_id).toBe(treasury.body.id);

    const rule = { refill_to: money("100.00"), when_below: money("500.00"), max_per_day: money("200.00") };
    const bad = await call(h.app, "PUT", `/v1/agents/${w.agent.id}/auto-topup`, {
      token: w.apiKey,
      body: {
        ...rule,
        owner_authorization: await ownerAuth(
          w.owner,
          h.clock,
          "topup.set",
          w.agent.id,
          ownerPayloads.topUpSet(w.agent.id, rule).payload,
        ),
      },
    });
    expect(bad.status).toBe(400); // when_below must be below refill_to

    const good = { refill_to: money("500.00"), when_below: money("300.00"), max_per_day: money("200.00") };
    const owner_authorization = await ownerAuth(
      w.owner,
      h.clock,
      "topup.set",
      w.agent.id,
      ownerPayloads.topUpSet(w.agent.id, good).payload,
    );
    const res = await call(h.app, "PUT", `/v1/agents/${w.agent.id}/auto-topup`, {
      token: w.apiKey,
      body: { ...good, owner_authorization },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending_install"); // until the owner operation succeeds
    const signed = await signOwnerOperation(h, w, res.headers["agentbank-owner-operation-id"] as string);
    expect(signed.body.status).toBe("succeeded");
    const current = await agentCall(h, w.session, "GET", `/v1/agents/${w.agent.id}/auto-topup`);
    expect(current.body).toMatchObject({
      status: "active",
      refill_to: money("500.00"),
      treasury_account_id: treasury.body.id,
    });

    h.sim.faucet(treasury.body.address, usdc("1000"));
    const before = h.sim.balanceOf(w.account.address);
    expect(await triggerTopUps(h.deps)).toBe(1);
    expect(h.sim.balanceOf(w.account.address) > before).toBe(true);
    expect(await triggerTopUps(h.deps)).toBe(0); // cooldown
  });

  it("lists neutral, clearly-labelled sandbox mock funds", async () => {
    const res = await call(h.app, "GET", "/v1/funds", { token: w.apiKey });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const fund of res.body.data) {
      expect(fund.chain_id).toBe(1337);
      expect(fund.name).toMatch(/Sandbox Mock/);
      expect(fund.disclosure).toMatch(/SANDBOX MOCK/);
    }
  });

  it("gates the treasury sweep behind FEATURE_TREASURY_SWEEP", async () => {
    const body = {
      fund_id: "fnd_00000000000000000000000004",
      threshold: money("100.00"),
      max_share_bps: 5000,
    };
    const res = await call(h.app, "PUT", `/v1/accounts/${w.account.id}/sweep-rule`, {
      token: w.apiKey,
      body: {
        ...body,
        owner_authorization: await ownerAuth(w.owner, h.clock, "sweep.set", w.account.id, body),
      },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("feature_gated");

    const enabled = await createHarness({ config: { FEATURE_TREASURY_SWEEP: "true" } });
    try {
      const x = await onboard(enabled, { name: "sweeper" });
      const auth = await ownerAuth(x.owner, enabled.clock, "sweep.set", x.account.id, body);
      const ok = await call(enabled.app, "PUT", `/v1/accounts/${x.account.id}/sweep-rule`, {
        token: x.apiKey,
        body: { ...body, owner_authorization: auth },
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ status: "pending_install", floor: money("0.00"), max_share_bps: 5000 });
    } finally {
      await enabled.close();
    }
  });

  it("polls receipts without error when nothing is pending", async () => {
    expect(await pollReceipts(h.deps)).toBeGreaterThanOrEqual(0);
  });
});
