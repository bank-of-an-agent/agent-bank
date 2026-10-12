import {
  agentEscrowAbi,
  approveCall,
  escrowDisputeCall,
  escrowLockCalls,
  escrowRefundCall,
  escrowReleaseCall,
  paymentStreamsAbi,
  SIMULATED_CONTRACTS,
  streamCancelCall,
  streamCreateCalls,
  streamTopUpCalls,
  transferCall,
  vaultDepositCalls,
  type Call,
} from "@agentbank/chain";
import {
  ownerPayloads,
  PolicyDocumentSchema,
  type CosignInternal,
  type CosignResultInternal,
} from "@agentbank/core";
import { encodeFunctionData, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTACKER, keys, PAYEE, signOwnerAction, usd, World } from "./helpers";

const escrow = SIMULATED_CONTRACTS.escrow as Address;
const streams = SIMULATED_CONTRACTS.streams as Address;
const vaults = SIMULATED_CONTRACTS.vaults as Address;
const TREASURY: Address = getAddress("0x0000000000000000000000000000000000007ea5");

function refusedWith(result: CosignResultInternal, rule: string): void {
  expect(result.signature).toBeNull();
  expect(result.decision.outcome).not.toBe("allow");
  expect(result.decision.rule_hits, JSON.stringify(result.decision.rule_hits)).toContainEqual(
    expect.objectContaining({ rule, effect: "deny" }),
  );
}

function lockCalls(w: World, amount: bigint): Call[] {
  return escrowLockCalls({
    escrow,
    token: w.usdc,
    payee: PAYEE,
    amount,
    expiresAt: BigInt(w.now() + 86_400),
    termsHash: keccak256(toHex("deliver the report")),
  });
}

async function cosignAndSubmit(
  w: World,
  calls: Call[],
  intent: Parameters<World["cosignRequest"]>[1],
  extra: Partial<CosignInternal> = {},
) {
  const prepared = await w.prepareOrCraft(calls);
  const result = await w.client.cosign(w.cosignRequest(prepared, intent, extra));
  expect(result.decision.outcome, JSON.stringify(result.decision.rule_hits)).toBe("allow");
  const receipt = await w.submit(prepared, result.signature as Hex);
  expect(receipt.status).toBe("succeeded");
  return result;
}

async function setTreasury(
  w: World,
  accountId = "acct_01JTREASURY0000000000000000",
  address = TREASURY,
  signer = keys.owner,
) {
  return w.client.setTreasury({
    org_id: w.org,
    chain_id: w.chain.chainId,
    owner_address: keys.owner.address,
    account_id: accountId,
    treasury_address: address,
    owner_authorization: await signOwnerAction(
      signer,
      w.chain.chainId,
      ownerPayloads.treasurySet(w.org, accountId),
      w.now(),
    ),
  });
}

describe("actions on existing escrows and streams", () => {
  let w: World;
  beforeAll(async () => {
    w = await World.create({
      policy: { limits: { per_day: "50.00" } },
      scope: { allowed_contracts: [escrow, streams] },
    });
  });
  afterAll(async () => {
    await w.close();
  });

  it("co-signs an escrow release that moves nothing out of the account, without counting spend", async () => {
    await cosignAndSubmit(w, lockCalls(w, usd(20)), { to: PAYEE, amount: usd(20), fee: 0n, kind: "escrow" });
    const release = await cosignAndSubmit(
      w,
      [escrowReleaseCall({ escrow, escrowId: 1n })],
      { to: PAYEE, amount: 0n, fee: 0n, kind: "escrow" },
      { action: "escrow.release", onchain_id: "1" },
    );
    expect(release.decision.rule_hits).toContainEqual(
      expect.objectContaining({ rule: "cosigner.no_outflow", effect: "allow" }),
    );
    expect(w.chain.balanceOf(PAYEE)).toBe(usd(20));
    // 20 of the 50 daily limit were used by the lock; the release counted nothing.
    expect((await w.pay(PAYEE, usd(30))).result.decision.outcome).toBe("allow");
    expect((await w.pay(PAYEE, usd(0.01))).result.decision.outcome).toBe("deny");
  });

  it("co-signs refunds and disputes as single calls on the configured escrow contract", async () => {
    for (const [action, call] of [
      ["escrow.refund", escrowRefundCall({ escrow, escrowId: 7n })],
      ["escrow.dispute", escrowDisputeCall({ escrow, escrowId: 7n })],
    ] as const) {
      const result = await w.client.cosign(
        w.cosignRequest(
          await w.craft([call]),
          { to: PAYEE, amount: 0n, fee: 0n, kind: "escrow" },
          { action, onchain_id: "7" },
        ),
      );
      expect(result.decision.outcome, action).toBe("allow");
    }
  });

  it("co-signs stream cancellations, and top-ups counted as stream spend", async () => {
    const fresh = await World.create({
      policy: { limits: { per_day: "50.00" } },
      scope: { allowed_contracts: [escrow, streams] },
    });
    try {
      const create = streamCreateCalls({
        streams,
        token: fresh.usdc,
        payee: PAYEE,
        deposit: usd(10),
        amountPerInterval: usd(1),
        interval: 3600n,
      });
      await cosignAndSubmit(fresh, create, { to: PAYEE, amount: usd(10), fee: 0n, kind: "stream" });
      await cosignAndSubmit(
        fresh,
        streamTopUpCalls({ streams, token: fresh.usdc, streamId: 1n, amount: usd(5) }),
        { to: PAYEE, amount: usd(5), fee: 0n, kind: "stream" },
        { action: "stream.top_up", onchain_id: "1" },
      );
      expect(fresh.chain.balanceOf(streams)).toBe(usd(15));
      // 10 + 5 of 50 used: 35 left.
      expect((await fresh.pay(PAYEE, usd(35.01))).result.decision.outcome).toBe("deny");
      await cosignAndSubmit(
        fresh,
        [streamCancelCall({ streams, streamId: 1n })],
        { to: PAYEE, amount: 0n, fee: 0n, kind: "stream" },
        { action: "stream.cancel", onchain_id: "1" },
      );
    } finally {
      await fresh.close();
    }
  });

  it("refuses post-lock actions that do not match exactly", async () => {
    const intent = { to: PAYEE, amount: 0n, fee: 0n, kind: "escrow" as const };
    const releaseCall = escrowReleaseCall({ escrow, escrowId: 1n });
    // A release aimed at a contract that is not the configured escrow decodes as unknown.
    const rogue = {
      to: ATTACKER,
      data: encodeFunctionData({ abi: agentEscrowAbi, functionName: "release", args: [1n] }),
    };
    refusedWith(
      await w.client.cosign(
        w.cosignRequest(await w.craft([rogue]), intent, { action: "escrow.release", onchain_id: "1" }),
      ),
      "cosigner.intent_mismatch",
    );
    const cases: [Call[], Partial<CosignInternal>, Partial<typeof intent>][] = [
      [[releaseCall], { action: "escrow.release", onchain_id: "1" }, { amount: usd(1) }], // claims an outflow
      [[releaseCall], { action: "escrow.release", onchain_id: "2" }, {}], // another escrow
      [[releaseCall], { action: "escrow.release" }, {}], // no id
      [
        [releaseCall, transferCall({ token: w.usdc, to: ATTACKER, amount: usd(1) })],
        { action: "escrow.release", onchain_id: "1" },
        {},
      ],
      [[escrowRefundCall({ escrow, escrowId: 1n })], { action: "escrow.release", onchain_id: "1" }, {}], // wrong function
      [[releaseCall], { action: "stream.cancel", onchain_id: "1" }, { kind: "stream" as never }], // wrong contract kind
      [[releaseCall], { action: "escrow.release", onchain_id: "1" }, { kind: "transfer" as never }], // action/kind mismatch
    ];
    for (const [calls, extra, override] of cases) {
      const result = await w.client.cosign(
        w.cosignRequest(await w.craft(calls), { ...intent, ...override }, extra),
      );
      refusedWith(result, "cosigner.intent_mismatch");
    }
  });

  it("refuses top-ups through another contract or for another stream", async () => {
    const intent = { to: PAYEE, amount: usd(5), fee: 0n, kind: "stream" as const };
    const extra = { action: "stream.top_up" as const, onchain_id: "1" };
    const [approve, topUp] = streamTopUpCalls({ streams, token: w.usdc, streamId: 1n, amount: usd(5) }) as [
      Call,
      Call,
    ];
    const elsewhere = {
      to: ATTACKER,
      data: encodeFunctionData({ abi: paymentStreamsAbi, functionName: "topUp", args: [1n, usd(5)] }),
    };
    for (const calls of [
      [approveCall({ token: w.usdc, spender: escrow, amount: usd(5) }), topUp], // approval to another contract
      [approve, elsewhere], // top-up call on a rogue contract
      [approveCall({ token: w.usdc, spender: ATTACKER, amount: usd(5) }), topUp],
    ]) {
      refusedWith(
        await w.client.cosign(w.cosignRequest(await w.craft(calls), intent, extra)),
        "cosigner.intent_mismatch",
      );
    }
    refusedWith(
      await w.client.cosign(
        w.cosignRequest(await w.craft([approve, topUp]), intent, { ...extra, onchain_id: "2" }),
      ),
      "cosigner.intent_mismatch",
    );
  });

  it("refuses everything, releases included, while the agent is frozen", async () => {
    const frozen = await World.create({ scope: { allowed_contracts: [escrow, streams] } });
    try {
      await frozen.client.freeze({ scope: "agent", id: frozen.agent, reason: "incident" });
      const result = await frozen.client.cosign(
        frozen.cosignRequest(
          await frozen.craft([escrowReleaseCall({ escrow, escrowId: 1n })]),
          { to: PAYEE, amount: 0n, fee: 0n, kind: "escrow" },
          { action: "escrow.release", onchain_id: "1" },
        ),
      );
      refusedWith(result, "agent.frozen");
    } finally {
      await frozen.close();
    }
  });

  it("refuses locked-vault deposits on the session path (owner operations only)", async () => {
    const calls = vaultDepositCalls({ vaults, token: w.usdc, vaultId: 1n, amount: usd(5) });
    const result = await w.client.cosign(
      w.cosignRequest(await w.craft(calls), { to: PAYEE, amount: usd(5), fee: 0n }),
    );
    refusedWith(result, "cosigner.vault_owner_only");
  });
});

describe("savings sweeps to the org treasury", () => {
  let w: World;
  beforeAll(async () => {
    w = await World.create({ policy: { limits: { per_tx: "100.00", per_day: "30.00" } } });
  });
  afterAll(async () => {
    await w.close();
  });

  const sweepCalls = (amount: bigint, sweep: bigint, to: Address = TREASURY): Call[] => [
    transferCall({ token: w.usdc, to: PAYEE, amount }),
    transferCall({ token: w.usdc, to, amount: sweep }),
  ];

  it("refuses a sweep while the org has no registered treasury", async () => {
    const request = w.cosignRequest(
      await w.craft(sweepCalls(usd(5), usd(2))),
      { to: PAYEE, amount: usd(5), fee: 0n },
      { savings_sweep: usd(2).toString() },
    );
    refusedWith(await w.client.cosign(request), "cosigner.treasury");
  });

  it("registers the treasury only with the owner's treasury.set authorization", async () => {
    await expect(setTreasury(w, undefined, undefined, keys.attacker)).rejects.toMatchObject({
      code: "owner_signature_required",
    });
    const signedForOther = {
      org_id: w.org,
      chain_id: w.chain.chainId,
      owner_address: keys.owner.address,
      account_id: "acct_01JOTHER000000000000000000",
      treasury_address: TREASURY,
      owner_authorization: await signOwnerAction(
        keys.owner,
        w.chain.chainId,
        ownerPayloads.treasurySet(w.org, "acct_01JTREASURY0000000000000000"),
        w.now(),
      ),
    };
    await expect(w.client.setTreasury(signedForOther)).rejects.toMatchObject({ code: "signature_invalid" });
    await expect(setTreasury(w, undefined, w.signer.address)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(setTreasury(w, "acct_01JAGENTASTREASURY000000000", w.account)).rejects.toMatchObject({
      code: "forbidden",
    });
    await setTreasury(w);
    await setTreasury(w); // idempotent
    w.clock.advanceSeconds(1);
    await expect(
      setTreasury(w, undefined, getAddress("0x0000000000000000000000000000000000007ea6")),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await w.client.audit(0, 1000)).records.filter((r) => r.action === "treasury.set")).toHaveLength(
      1,
    );
  });

  it("co-signs an exact sweep to the treasury; it is outflow, not policy spend", async () => {
    const prepared = await w.prepareOrCraft(sweepCalls(usd(25), usd(40)));
    const result = await w.client.cosign(
      w.cosignRequest(
        prepared,
        { to: PAYEE, amount: usd(25), fee: 0n },
        { savings_sweep: usd(40).toString() },
      ),
    );
    expect(result.decision.outcome, JSON.stringify(result.decision.rule_hits)).toBe("allow");
    expect((await w.submit(prepared, result.signature as Hex)).status).toBe("succeeded");
    expect(w.chain.balanceOf(TREASURY)).toBe(usd(40));
    // Only the 25 payment counts against the 30 daily limit.
    expect((await w.pay(PAYEE, usd(5))).result.decision.outcome).toBe("allow");
    expect((await w.pay(PAYEE, usd(0.01))).result.decision.outcome).toBe("deny");
  });

  it("refuses wrong amounts, undeclared sweeps and sweeps to other addresses", async () => {
    const intent = { to: PAYEE, amount: usd(1), fee: 0n };
    refusedWith(
      await w.client.cosign(
        w.cosignRequest(await w.craft(sweepCalls(usd(1), usd(3))), intent, {
          savings_sweep: usd(2).toString(),
        }),
      ),
      "cosigner.treasury",
    );
    refusedWith(
      await w.client.cosign(w.cosignRequest(await w.craft(sweepCalls(usd(1), usd(2))), intent)),
      "cosigner.intent_mismatch",
    );
    refusedWith(
      await w.client.cosign(
        w.cosignRequest(await w.craft(sweepCalls(usd(1), usd(2), ATTACKER)), intent, {
          savings_sweep: usd(2).toString(),
        }),
      ),
      "cosigner.treasury",
    );
    refusedWith(
      await w.client.cosign(
        w.cosignRequest(await w.craft([transferCall({ token: w.usdc, to: PAYEE, amount: usd(1) })]), intent, {
          savings_sweep: usd(2).toString(),
        }),
      ),
      "cosigner.treasury",
    );
  });

  it("counts sweeps in the session's on-chain outflow caps", async () => {
    const tight = await World.create({ scope: { max_per_tx: "50.00" } });
    try {
      await setTreasury(tight);
      const request = tight.cosignRequest(
        await tight.craft([
          transferCall({ token: tight.usdc, to: PAYEE, amount: usd(10) }),
          transferCall({ token: tight.usdc, to: TREASURY, amount: usd(45) }),
        ]),
        { to: PAYEE, amount: usd(10), fee: 0n },
        { savings_sweep: usd(45).toString() },
      );
      refusedWith(await tight.client.cosign(request), "cosigner.session_outflow");
    } finally {
      await tight.close();
    }
  });
});

describe("owner rotation", () => {
  let w: World;
  beforeAll(async () => {
    w = await World.create();
  });
  afterAll(async () => {
    await w.close();
  });

  async function rotation(
    signer = keys.owner,
    current: Address = keys.owner.address,
    next: Address = keys.otherOwner.address,
  ) {
    return {
      org_id: w.org,
      chain_id: w.chain.chainId,
      owner_address: current,
      new_owner_address: next,
      owner_authorization: await signOwnerAction(
        signer,
        w.chain.chainId,
        ownerPayloads.ownerRotate(w.org, next),
        w.now(),
      ),
    };
  }

  it("refuses rotations not signed by the current owner", async () => {
    await expect(w.client.rotateOwner(await rotation(keys.attacker))).rejects.toMatchObject({
      code: "owner_signature_required",
    });
    await expect(
      w.client.rotateOwner(await rotation(keys.attacker, keys.attacker.address)),
    ).rejects.toMatchObject({ code: "owner_signature_required" });
    await expect(
      w.client.rotateOwner(await rotation(keys.owner, keys.owner.address, w.signer.address)),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      w.client.rotateOwner({ ...(await rotation()), org_id: "org_01JUNKNOWN0000000000000000" }),
    ).rejects.toThrow();
  });

  it("rotates on the current owner's authorization; only the new owner can authorize afterwards", async () => {
    const request = await rotation();
    await w.client.rotateOwner(request);
    await w.client.rotateOwner(request); // identical retry
    const records = (await w.client.audit(0, 1000)).records.filter((r) => r.action === "owner.rotated");
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({
      previous_owner: keys.owner.address,
      new_owner: keys.otherOwner.address,
    });
    const looser = {
      limits: { per_tx: "150.00", per_day: "300.00", per_week: "1000.00", per_month: "3000.00" },
    };
    await expect(w.putPolicy(looser)).rejects.toMatchObject({ code: "forbidden" });
    const byNewOwner = await w.client.putPolicy({
      org_id: w.org,
      agent_id: w.agent,
      chain_id: w.chain.chainId,
      owner_address: keys.otherOwner.address,
      policy: looser as never,
      owner_authorization: await signOwnerAction(
        keys.otherOwner,
        w.chain.chainId,
        ownerPayloads.policyLoosen(w.agent, PolicyDocumentSchema.parse(looser)),
        w.now(),
      ),
    });
    expect(byNewOwner).toMatchObject({ change_kind: "loosen", signed_by: keys.otherOwner.address });
  });
});

describe("owner keys are never Agent Bank keys", () => {
  it("refuses an owner, a new owner or a treasury that is the co-signer's key", async () => {
    const w = await World.create();
    try {
      await expect(
        w.client.putPolicy({
          org_id: w.org,
          agent_id: w.agent,
          chain_id: w.chain.chainId,
          owner_address: w.signer.address,
          policy: { limits: {} } as never,
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    } finally {
      await w.close();
    }
  });
});
