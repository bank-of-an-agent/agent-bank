import {
  disableModuleRegistryCall,
  escrowDisputeCall,
  escrowLockCalls,
  escrowRefundCall,
  escrowReleaseCall,
  escrowResolveCall,
  streamCancelCall,
  streamCreateCalls,
  streamSettleCall,
  topUpCall,
  topUpExecutorInstallCalls,
  vaultCreateCall,
  vaultDepositCalls,
  vaultWithdrawCall,
} from "@agentbank/chain";
import { newId } from "@agentbank/core";
import { chainRef, pocketRef, revenueRef, vaultRef } from "@agentbank/ledger";
import type { Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { hashOf } from "./support/events";
import { SimBank, usd, type SimAccount } from "./support/sim-bank";

async function expectReconciled(bank: SimBank): Promise<void> {
  const balances = await bank.compareBalances();
  expect(balances.filter((b) => b.onchain !== b.expected)).toEqual([]);
  expect((await bank.ledger.verifyInvariants()).violations).toEqual([]);
  expect((await bank.reconciler.verify()).violations).toEqual([]);
  expect(await bank.suspense()).toBe(0n);
}

async function eventTypes(bank: SimBank): Promise<string[]> {
  const { rows } = await bank.db.query<{ type: string }>("SELECT type FROM event ORDER BY created_at, id");
  return rows.map((r) => r.type);
}

const pocket = (a: SimAccount, name: "operating" | "escrow" | "stream") => pocketRef(a.id, name, "USDC");

describe("escrow, streams, vaults and top-ups", () => {
  let bank: SimBank;
  afterEach(async () => bank?.close());

  async function lockEscrow(
    payer: SimAccount,
    payee: Address,
    amount: bigint,
    options: { arbiter?: Address; payeeAgentId?: string | null } = {},
  ): Promise<{ escrowId: string; paymentId: string }> {
    const contract = bank.chain.contracts.escrow as Address;
    const expiresAt = new Date(bank.now().getTime() + 86_400_000);
    const fee = amount / 100n < usd(1) ? usd(1) : amount / 100n;
    const p = await bank.payWith(payer, {
      kind: "escrow",
      to: contract,
      amount,
      fee,
      calls: escrowLockCalls({
        escrow: contract,
        token: bank.chain.contracts.usdc,
        payee,
        amount,
        expiresAt: BigInt(Math.floor(expiresAt.getTime() / 1000)),
        ...(options.arbiter ? { arbiter: options.arbiter } : {}),
        termsHash: hashOf(`terms:${p0++}`),
      }),
    });
    await bank.flushRows();
    const escrowId = newId("escrow", bank.now().getTime());
    await bank.db.query(
      `INSERT INTO escrow (id, payer_account_id, payee_address, payee_agent_id, amount, fee, status, release_mode, arbiter,
                           contract_address, expires_at, pending_action, payment_id, org_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'locking', $7, $8, $9, $10, 'lock', $11, $12, $13, $13)`,
      [
        escrowId,
        payer.id,
        payee,
        options.payeeAgentId ?? null,
        amount,
        fee,
        options.arbiter ? "arbiter" : "payer",
        options.arbiter ?? null,
        contract,
        expiresAt,
        p.id,
        payer.orgId,
        bank.now(),
      ],
    );
    return { escrowId, paymentId: p.id };
  }
  let p0 = 0;

  async function escrowRow(id: string): Promise<{ status: string; onchain_id: string | null }> {
    const { rows } = await bank.db.query<{ status: string; onchain_id: string | null }>(
      "SELECT status, onchain_id FROM escrow WHERE id = $1",
      [id],
    );
    return rows[0] as { status: string; onchain_id: string | null };
  }

  it("escrow: lock, release to an agent, dispute and resolve, refund by the payee", async () => {
    bank = await SimBank.create();
    const org = await bank.createOrg();
    const payer = await bank.createAccount(org);
    const payee = await bank.createAccount(org);
    const outsider = privateKeyToAccount(generatePrivateKey());
    const arbiter = privateKeyToAccount(generatePrivateKey());
    bank.faucet(payer.address, usd(90));
    await bank.sync();
    const escrow = bank.chain.contracts.escrow as Address;

    const e1 = await lockEscrow(payer, payee.address, usd(20), { payeeAgentId: payee.agentId });
    const e2 = await lockEscrow(payer, outsider.address, usd(20), { arbiter: arbiter.address });
    const e3 = await lockEscrow(payer, outsider.address, usd(10));
    await bank.sync();
    for (const e of [e1, e2, e3]) {
      expect(await bank.paymentStatus(e.paymentId)).toBe("settled");
      expect((await escrowRow(e.escrowId)).status).toBe("locked");
    }
    expect((await escrowRow(e1.escrowId)).onchain_id).toBe("1");
    expect(await bank.ledger.balance(pocket(payer, "escrow"))).toBe(usd(50));
    expect(await bank.ledger.balance(revenueRef("USDC"))).toBe(usd(3));
    await expectReconciled(bank); // the escrow contract holds exactly the escrow pockets

    await bank.operate(payer, [escrowReleaseCall({ escrow, escrowId: 1n })]);
    await bank.operate(payer, [escrowDisputeCall({ escrow, escrowId: 2n })]);
    await bank.sync();
    expect((await escrowRow(e1.escrowId)).status).toBe("released");
    expect((await escrowRow(e2.escrowId)).status).toBe("disputed");
    expect(await bank.ledger.balance(pocket(payee, "operating"))).toBe(usd(20));

    bank.chain.sendTransaction({
      from: arbiter.address,
      to: escrow,
      data: escrowResolveCall({ escrow, escrowId: 2n, payeeAmount: usd(12) }).data,
    });
    bank.chain.sendTransaction({
      from: outsider.address,
      to: escrow,
      data: escrowRefundCall({ escrow, escrowId: 3n }).data,
    });
    await bank.sync();
    expect((await escrowRow(e2.escrowId)).status).toBe("resolved");
    expect((await escrowRow(e3.escrowId)).status).toBe("refunded");
    expect(await bank.ledger.balance(pocket(payer, "escrow"))).toBe(0n);
    expect(await bank.ledger.balance(pocket(payer, "operating"))).toBe(usd(90) - usd(53) + usd(8) + usd(10));
    expect(await bank.ledger.balance(chainRef(bank.chain.chainId, "USDC"))).toBe(-usd(90) + usd(12));
    const types = await eventTypes(bank);
    for (const t of ["escrow.locked", "escrow.released", "escrow.disputed", "escrow.refunded"])
      expect(types).toContain(t);
    await expectReconciled(bank);
  });

  it("streams: create, keeper settlement to an agent, cancel with refund", async () => {
    bank = await SimBank.create();
    const org = await bank.createOrg();
    const payer = await bank.createAccount(org);
    const payee = await bank.createAccount(org);
    bank.faucet(payer.address, usd(40));
    await bank.sync();
    const streams = bank.chain.contracts.streams as Address;
    const p = await bank.payWith(payer, {
      kind: "stream",
      to: streams,
      amount: usd(10),
      fee: 50_000n,
      calls: streamCreateCalls({
        streams,
        token: bank.chain.contracts.usdc,
        payee: payee.address,
        deposit: usd(10),
        amountPerInterval: usd(1),
        interval: 3600n,
      }),
    });
    await bank.flushRows();
    const streamId = newId("stream", bank.now().getTime());
    await bank.db.query(
      `INSERT INTO stream (id, payer_account_id, payee_address, payee_agent_id, kind, amount_per_interval, interval_seconds,
                           deposit, start_at, status, contract_address, payment_id, org_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'streaming', $5, 3600, $6, $7, 'requires_signature', $8, $9, $10, $7, $7)`,
      [streamId, payer.id, payee.address, payee.agentId, usd(1), usd(10), bank.now(), streams, p.id, org],
    );
    await bank.sync();
    const row = async () =>
      (
        await bank.db.query<{ status: string; onchain_id: string; settled: bigint }>(
          "SELECT status, onchain_id, settled FROM stream WHERE id = $1",
          [streamId],
        )
      ).rows[0];
    expect(await row()).toEqual({ status: "active", onchain_id: "1", settled: 0n });
    expect(await bank.ledger.balance(pocket(payer, "stream"))).toBe(usd(10));
    await expectReconciled(bank);

    bank.tick(2 * 3600 + 10);
    await bank.chain.gateway.relayCall({ call: streamSettleCall({ streams, streamId: 1n }) });
    await bank.sync();
    expect((await row())?.settled).toBe(usd(2));
    expect(await bank.ledger.balance(pocket(payee, "operating"))).toBe(usd(2));

    bank.tick(3600);
    await bank.operate(payer, [streamCancelCall({ streams, streamId: 1n })]);
    await bank.sync();
    expect(await row()).toEqual({ status: "canceled", onchain_id: "1", settled: usd(3) });
    expect(await bank.ledger.balance(pocket(payee, "operating"))).toBe(usd(3));
    expect(await bank.ledger.balance(pocket(payer, "stream"))).toBe(0n);
    expect(await bank.ledger.balance(pocket(payer, "operating"))).toBe(usd(40) - usd(10) - 50_000n + usd(7));
    const types = await eventTypes(bank);
    for (const t of ["stream.created", "stream.settled", "stream.canceled"]) expect(types).toContain(t);
    await expectReconciled(bank);
  });

  it("locked vaults: deposit into the vault contract, withdraw after unlock", async () => {
    bank = await SimBank.create();
    const org = await bank.createOrg();
    const account = await bank.createAccount(org);
    bank.faucet(account.address, usd(30));
    await bank.sync();
    const vaults = bank.chain.contracts.vaults as Address;
    const token = bank.chain.contracts.usdc;
    const unlockAt = BigInt(bank.chain.nowSeconds() + 3600);
    await bank.operate(account, [vaultCreateCall({ vaults, token, unlockAt, owner: account.owner.address })]);
    const vaultId = newId("vault", bank.now().getTime());
    await bank.db.query(
      `INSERT INTO vault (id, account_id, kind, name, unlock_at, contract_address, onchain_id, created_at)
       VALUES ($1, $2, 'locked', 'rainy day', $3, $4, '1', $5)`,
      [vaultId, account.id, new Date(Number(unlockAt) * 1000), vaults, bank.now()],
    );
    await bank.ledger.ensureAccount({ ...vaultRef(account.id, vaultId, "USDC"), location: "vault_contract" });
    const p = await bank.payWith(account, {
      kind: "vault",
      to: vaults,
      amount: usd(12),
      fee: 0n,
      calls: vaultDepositCalls({ vaults, token, vaultId: 1n, amount: usd(12) }),
    });
    await bank.flushRows();
    await bank.db.query("UPDATE payment SET vault_id = $2 WHERE id = $1", [p.id, vaultId]);
    await bank.sync();
    expect(await bank.paymentStatus(p.id)).toBe("settled");
    expect(await bank.ledger.balance(vaultRef(account.id, vaultId, "USDC"))).toBe(usd(12));
    await expectReconciled(bank); // the vault contract holds exactly the locked vault pockets

    bank.tick(3601);
    await bank.chain.gateway.relayCall({ call: vaultWithdrawCall({ vaults, vaultId: 1n, amount: usd(12) }) });
    await bank.sync();
    expect(await bank.ledger.balance(vaultRef(account.id, vaultId, "USDC"))).toBe(0n);
    expect(await bank.ledger.balance(pocket(account, "operating"))).toBe(usd(30));
    await expectReconciled(bank);
  });

  it("auto top-up: the executor moves funds from the org treasury to its agent", async () => {
    bank = await SimBank.create();
    const org = await bank.createOrg();
    const treasury = await bank.createAccount(org, { role: "treasury" });
    const agent = await bank.createAccount(org);
    bank.faucet(treasury.address, usd(90));
    await bank.sync();
    await bank.operate(treasury, [
      disableModuleRegistryCall({ account: treasury.address }),
      ...topUpExecutorInstallCalls({
        account: treasury.address,
        contracts: bank.chain.contracts,
        rules: [
          {
            agent: agent.address,
            token: bank.chain.contracts.usdc,
            refillTo: usd(50),
            whenBelow: usd(20),
            maxPerDay: usd(60),
          },
        ],
      }),
    ]);
    await bank.chain.gateway.relayCall({
      call: topUpCall({
        executor: bank.chain.contracts.topUpExecutor as Address,
        treasury: treasury.address,
        agent: agent.address,
      }),
    });
    await bank.sync();
    expect(await bank.ledger.balance(pocket(treasury, "operating"))).toBe(usd(40));
    expect(await bank.ledger.balance(pocket(agent, "operating"))).toBe(usd(50));
    expect(await eventTypes(bank)).toContain("deposit.received");
    await expectReconciled(bank);
  });
});
