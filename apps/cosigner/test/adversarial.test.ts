import {
  approveCall,
  escrowLockCalls,
  safe7579Abi,
  sessionInstallCalls,
  sessionSalt,
  signOperationHash,
  transferCall,
  transferFromCall,
  type Call,
} from "@agentbank/chain";
import { AgentBankError, CosignResultInternal, newId, type CosignInternal } from "@agentbank/core";
import {
  concatHex,
  encodeFunctionData,
  getAddress,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ATTACKER, DEFAULT_POLICY, keys, PAYEE, REVENUE, tamper, usd, World } from "./helpers";

async function expectRefused(w: World, request: CosignInternal, rule: string, detail?: RegExp) {
  const result = await w.client.cosign(request);
  expect(CosignResultInternal.parse(result)).toEqual(result);
  expect(result.signature).toBeNull();
  expect(result.decision.outcome).not.toBe("allow");
  const found = result.decision.rule_hits.find(
    (h) => h.rule === rule && h.effect !== "allow" && h.effect !== "info",
  );
  expect(found, `expected ${rule} in ${JSON.stringify(result.decision.rule_hits)}`).toBeDefined();
  if (detail) expect(found?.detail).toMatch(detail);
  return result;
}

describe("operations whose calls differ from the stated intent", () => {
  let w: World;
  beforeAll(async () => {
    w = await World.create();
  });
  afterAll(async () => {
    await w.close();
  });

  async function claimTransfer(
    calls: Call[],
    to: Address,
    amount: bigint,
    fee = 0n,
    extra: Partial<CosignInternal> = {},
  ) {
    return w.cosignRequest(await w.craft(calls), { to, amount, fee }, extra);
  }

  it("refuses an operation that pays someone other than the stated payee", async () => {
    const request = await claimTransfer(w.transferCalls(ATTACKER, usd(10), 0n), PAYEE, usd(10));
    await expectRefused(w, request, "cosigner.intent_mismatch", /pays .*not the stated payee/);
  });

  it("refuses an extra call smuggled next to the payment", async () => {
    const calls = [
      ...w.transferCalls(PAYEE, usd(10), 0n),
      transferCall({ token: w.usdc, to: ATTACKER, amount: usd(1) }),
    ];
    await expectRefused(
      w,
      await claimTransfer(calls, PAYEE, usd(10)),
      "cosigner.intent_mismatch",
      /exactly one USDC transfer/,
    );
  });

  it("refuses an inflated amount", async () => {
    const request = await claimTransfer(w.transferCalls(PAYEE, usd(99), 0n), PAYEE, usd(9));
    await expectRefused(w, request, "cosigner.intent_mismatch", /not the stated amount/);
  });

  it("refuses an approval to an attacker, alone or inside an escrow", async () => {
    const calls = [
      approveCall({ token: w.usdc, spender: ATTACKER, amount: usd(1000) }),
      ...w.transferCalls(PAYEE, usd(10), 0n),
    ];
    await expectRefused(w, await claimTransfer(calls, PAYEE, usd(10)), "cosigner.intent_mismatch");

    const [, lock] = escrowLockCalls({
      escrow: w.chain.contracts.escrow as Address,
      token: w.usdc,
      payee: PAYEE,
      amount: usd(10),
      expiresAt: BigInt(w.now() + 86_400),
      termsHash: keccak256(toHex("terms")),
    }) as [Call, Call];
    const escrow = w.cosignRequest(
      await w.craft([approveCall({ token: w.usdc, spender: ATTACKER, amount: usd(10) }), lock]),
      { to: PAYEE, amount: usd(10), fee: 0n, kind: "escrow" },
    );
    await expectRefused(w, escrow, "cosigner.intent_mismatch", /approves .*not the escrow contract/);
  });

  it("requires an escrow approval to be immediately followed by its lock", async () => {
    const [approve, lock] = escrowLockCalls({
      escrow: w.chain.contracts.escrow as Address,
      token: w.usdc,
      payee: PAYEE,
      amount: usd(10),
      expiresAt: BigInt(w.now() + 86_400),
      termsHash: keccak256(toHex("terms")),
    }) as [Call, Call];
    const fee = transferCall({ token: w.usdc, to: REVENUE, amount: usd(1) });
    const split = w.cosignRequest(await w.craft([approve, fee, lock]), {
      to: PAYEE,
      amount: usd(10),
      fee: usd(1),
      kind: "escrow",
    });
    await expectRefused(w, split, "cosigner.intent_mismatch", /immediately followed/);
  });

  it("refuses operations without a signing deadline", async () => {
    const prepared = await w.prepare(w.transferCalls(PAYEE, usd(10), 0n));
    const request = w.cosignRequest(prepared, { to: PAYEE, amount: usd(10), fee: 0n });
    const { validUntil: _dropped, ...withoutDeadline } = request.operation;
    await expectRefused(w, { ...request, operation: withoutDeadline }, "cosigner.operation", /malformed/);
  });

  it("refuses fees routed anywhere but the revenue address, understated fees and oversized sweeps", async () => {
    const elsewhere = [
      ...w.transferCalls(PAYEE, usd(10), 0n),
      transferCall({ token: w.usdc, to: ATTACKER, amount: usd(0.02) }),
    ];
    await expectRefused(
      w,
      await claimTransfer(elsewhere, PAYEE, usd(10), usd(0.02)),
      "cosigner.intent_mismatch",
    );
    await expectRefused(
      w,
      await claimTransfer(w.transferCalls(PAYEE, usd(10), 0n), PAYEE, usd(10), usd(0.02)),
      "cosigner.intent_mismatch",
      /less than the stated fee/,
    );
    const sweep = [
      ...w.transferCalls(PAYEE, usd(10), usd(0.02)),
      transferCall({ token: w.usdc, to: REVENUE, amount: usd(150) }),
    ];
    await expectRefused(
      w,
      await claimTransfer(sweep, PAYEE, usd(10), usd(0.02)),
      "cosigner.intent_mismatch",
      /fee sweep .* exceeds/,
    );
    const three = [
      ...w.transferCalls(PAYEE, usd(10), usd(0.02)),
      transferCall({ token: w.usdc, to: REVENUE, amount: usd(1) }),
      transferCall({ token: w.usdc, to: REVENUE, amount: usd(1) }),
    ];
    await expectRefused(
      w,
      await claimTransfer(three, PAYEE, usd(10), usd(0.02)),
      "cosigner.intent_mismatch",
      /at most 2/,
    );
  });

  it("refuses other tokens, native value, transferFrom and module calls", async () => {
    const fakeToken = getAddress("0x000000000000000000000000000000000000dead");
    await expectRefused(
      w,
      await claimTransfer([transferCall({ token: fakeToken, to: PAYEE, amount: usd(10) })], PAYEE, usd(10)),
      "cosigner.intent_mismatch",
      /token other than USDC/,
    );
    await expectRefused(
      w,
      await claimTransfer(
        [{ ...transferCall({ token: w.usdc, to: PAYEE, amount: usd(10) }), value: 1n }],
        PAYEE,
        usd(10),
      ),
      "cosigner.intent_mismatch",
      /native value/,
    );
    const pull = transferFromCall({ token: w.usdc, from: PAYEE, to: ATTACKER, amount: usd(10) });
    await expectRefused(w, await claimTransfer([pull], PAYEE, usd(10)), "cosigner.intent_mismatch");
    const install = sessionInstallCalls({
      contracts: w.chain.contracts,
      grant: {
        sessionKey: keys.attacker.address,
        cosigner: w.signer.address,
        salt: sessionSalt("ses_evil"),
        scope: {
          token: w.usdc,
          maxPerTx: usd(1_000_000),
          maxPerDay: usd(1_000_000),
          allowedRecipients: [],
          allowedContracts: [],
          issuedAt: w.now(),
          expiresAt: w.now() + 3600,
        },
      },
    });
    await expectRefused(w, await claimTransfer(install, PAYEE, usd(10)), "cosigner.intent_mismatch");
  });

  it("refuses calldata that is not a plain execution (delegatecall mode)", async () => {
    const prepared = await w.prepare(w.transferCalls(PAYEE, usd(10), 0n));
    const delegate = await tamper(prepared.op, (userOp) => {
      userOp.callData = encodeFunctionData({
        abi: safe7579Abi,
        functionName: "execute",
        args: [pad("0xff", { size: 32, dir: "right" }), concatHex([ATTACKER, "0x"])],
      });
    });
    await expectRefused(
      w,
      w.cosignRequest(delegate, { to: PAYEE, amount: usd(10), fee: 0n }),
      "cosigner.intent_mismatch",
      /not a recognised call/,
    );
  });

  it("refuses x402 intents (spend-key payments are authorized, never co-signed) and contracts on transfers", async () => {
    const prepared = await w.prepare(w.transferCalls(PAYEE, usd(10), 0n));
    await expectRefused(
      w,
      w.cosignRequest(prepared, { to: PAYEE, amount: usd(10), fee: 0n, kind: "x402" }),
      "cosigner.intent_mismatch",
      /x402/,
    );
    const withContract = w.cosignRequest(prepared, { to: PAYEE, amount: usd(10), fee: 0n });
    withContract.intent.counterparty.contract = w.chain.contracts.escrow as Address;
    await expectRefused(w, withContract, "cosigner.intent_mismatch", /goes through no contract/);
  });

  it("audits every refusal", async () => {
    const audit = await w.client.audit(0, 1000);
    const refusals = audit.records.filter((r) => r.action === "cosign.refused");
    expect(refusals.length).toBeGreaterThanOrEqual(10);
    expect(audit.records.some((r) => r.action === "cosign.signed")).toBe(false);
    expect(w.chain.balanceOf(ATTACKER)).toBe(0n);
  });
});

describe("hash, signature and operation checks", () => {
  let w: World;
  beforeAll(async () => {
    w = await World.create();
  });
  afterAll(async () => {
    await w.close();
  });

  it("refuses a user_op_hash that is not the hash of the operation", async () => {
    const prepared = await w.prepare(w.transferCalls(PAYEE, usd(10), 0n));
    const bogus = keccak256(toHex("some other operation"));
    const request = w.cosignRequest(
      { op: prepared.op, sessionSignature: await signOperationHash(keys.session, bogus) },
      { to: PAYEE, amount: usd(10), fee: 0n },
      { user_op_hash: bogus },
    );
    await expectRefused(w, request, "cosigner.user_op_hash");
  });

  it("refuses an operation altered after the session key signed it", async () => {
    const prepared = await w.prepare(w.transferCalls(PAYEE, usd(10), 0n));
    const request = w.cosignRequest(prepared, { to: ATTACKER, amount: usd(10), fee: 0n });
    const altered = await tamper(prepared.op, (userOp) => {
      userOp.callData = encodeFunctionData({
        abi: safe7579Abi,
        functionName: "execute",
        args: [
          pad("0x00", { size: 32 }),
          concatHex([
            w.usdc,
            pad("0x00", { size: 32 }),
            transferCall({ token: w.usdc, to: ATTACKER, amount: usd(10) }).data,
          ]),
        ],
      });
    });
    // Same hash and signature as the original, but the raw operation pays the attacker.
    await expectRefused(
      w,
      { ...request, operation: JSON.parse(JSON.stringify(altered.op)) as Record<string, unknown> },
      "cosigner.user_op_hash",
    );
    // Re-hashed consistently, but the session key never signed the new hash.
    await expectRefused(
      w,
      {
        ...request,
        operation: JSON.parse(JSON.stringify(altered.op)) as Record<string, unknown>,
        user_op_hash: altered.op.userOpHash,
      },
      "cosigner.session_signature",
    );
  });

  it("refuses a session signature by any other key, or garbage", async () => {
    const prepared = await w.prepare(w.transferCalls(PAYEE, usd(10), 0n));
    const other = await signOperationHash(keys.otherSession, prepared.op.userOpHash);
    await expectRefused(
      w,
      w.cosignRequest({ ...prepared, sessionSignature: other }, { to: PAYEE, amount: usd(10), fee: 0n }),
      "cosigner.session_signature",
    );
    await expectRefused(
      w,
      w.cosignRequest({ ...prepared, sessionSignature: "0x1234" }, { to: PAYEE, amount: usd(10), fee: 0n }),
      "cosigner.session_signature",
    );
  });

  it("refuses owner-path operations, other accounts, other chains and unknown entry points", async () => {
    const owner = await w.chain.gateway.prepareOwnerOperation({
      account: w.account,
      calls: w.transferCalls(PAYEE, usd(10), 0n),
    });
    const ownerRequest = w.cosignRequest(
      { op: owner, sessionSignature: await signOperationHash(keys.session, owner.userOpHash) },
      { to: PAYEE, amount: usd(10), fee: 0n },
    );
    await expectRefused(w, ownerRequest, "cosigner.operation", /owner/);

    const prepared = await w.prepare(w.transferCalls(PAYEE, usd(10), 0n));
    const base = w.cosignRequest(prepared, { to: PAYEE, amount: usd(10), fee: 0n });
    await expectRefused(
      w,
      { ...base, account_address: getAddress("0x00000000000000000000000000000000000a11ce") },
      "cosigner.operation",
      /sender/,
    );
    await expectRefused(w, { ...base, chain_id: 84532 }, "cosigner.chain");
    const operation = {
      ...base.operation,
      entryPoint: getAddress("0x0000000000000000000000000000000000e47e47"),
    };
    await expectRefused(w, { ...base, operation }, "cosigner.operation", /EntryPoint/);
    await expectRefused(w, { ...base, operation: { nonsense: true } }, "cosigner.operation", /malformed/);
  });

  it("refuses operations past their signing deadline", async () => {
    const prepared = await w.prepare(w.transferCalls(PAYEE, usd(10), 0n));
    w.clock.advanceSeconds(11 * 60);
    await expectRefused(
      w,
      w.cosignRequest(prepared, { to: PAYEE, amount: usd(10), fee: 0n }),
      "cosigner.operation",
      /deadline/,
    );
  });

  it("allows one co-signature per payment and one payment per operation", async () => {
    const first = await w.pay(PAYEE, usd(10));
    expect(first.result.decision.outcome).toBe("allow");
    const other = await w.prepare(w.transferCalls(PAYEE, usd(11), 0n));
    const samePayment = w.cosignRequest(
      other,
      { to: PAYEE, amount: usd(11), fee: 0n },
      { payment_id: first.request.payment_id },
    );
    await expectRefused(w, samePayment, "cosigner.payment_replay");
    await expectRefused(w, { ...first.request, payment_id: "pay_replayed" }, "cosigner.operation_replay");
  });
});

describe("session state", () => {
  let w: World;
  afterEach(async () => {
    await w.close();
  });

  it("refuses unknown sessions and sessions of another account", async () => {
    w = await World.create();
    const prepared = await w.prepare(w.transferCalls(PAYEE, usd(10), 0n));
    await expectRefused(
      w,
      w.cosignRequest(prepared, { to: PAYEE, amount: usd(10), fee: 0n }, { session_id: "ses_unknown" }),
      "cosigner.session",
      /Unknown session/,
    );
    await expectRefused(
      w,
      w.cosignRequest(prepared, { to: PAYEE, amount: usd(10), fee: 0n }, { account_id: "acct_other" }),
      "cosigner.session",
      /another account/,
    );
    await expectRefused(
      w,
      w.cosignRequest(prepared, { to: PAYEE, amount: usd(10), fee: 0n }, { agent_id: "agt_other" }),
      "cosigner.session",
      /another agent/,
    );
  });

  it("refuses an expired session", async () => {
    w = await World.create();
    w.clock.advanceSeconds(24 * 3600 + 1);
    const prepared = await w.prepare(w.transferCalls(PAYEE, usd(10), 0n));
    await expectRefused(
      w,
      w.cosignRequest(prepared, { to: PAYEE, amount: usd(10), fee: 0n }),
      "session.expired",
    );
  });

  it("refuses a revoked session, which can never be registered again", async () => {
    w = await World.create();
    await w.client.revokeSession(w.sessionId);
    await w.client.revokeSession(w.sessionId); // idempotent
    await expectRefused(w, (await w.pay(PAYEE, usd(10))).request, "session.revoked");
    await expect(w.registerSession()).rejects.toMatchObject({ code: "session_revoked" });
  });

  it("refuses frozen sessions, agents and orgs", async () => {
    w = await World.create();
    await w.client.freeze({ scope: "session", id: w.sessionId, reason: "suspicious" });
    await expectRefused(w, (await w.pay(PAYEE, usd(10))).request, "cosigner.session_frozen");
  });

  it("refuses when the agent or the org is frozen", async () => {
    w = await World.create();
    await w.client.freeze({ scope: "agent", id: w.agent, reason: "suspicious" });
    expect(
      (await w.pay(PAYEE, usd(10))).result.decision.rule_hits.some(
        (h) => h.rule === "agent.frozen" && h.effect === "deny",
      ),
    ).toBe(true);
    await w.client.freeze({ scope: "org", id: w.org, reason: "mass freeze" });
    const res = await w.pay(PAYEE, usd(10));
    expect(res.result.signature).toBeNull();
    expect(res.result.decision.rule_hits.some((h) => h.rule === "org.frozen" && h.effect === "deny")).toBe(
      true,
    );
  });
});

describe("failing closed", () => {
  let w: World;
  afterEach(async () => {
    await w.close();
  });

  it("COSIGNER_FAIL_CLOSED refuses every evaluation, co-signature and x402 authorization", async () => {
    w = await World.create({ failClosed: true });
    const { result } = await w.pay(PAYEE, usd(1));
    expect(result.signature).toBeNull();
    expect(result.decision.outcome).toBe("deny");
    expect(result.decision.rule_hits[0]?.rule).toBe("cosigner.fail_closed");
    const evaluated = await w.client.evaluate({
      org_id: w.org,
      agent_id: w.agent,
      account_id: w.accountId,
      account_address: w.account,
      chain_id: w.chain.chainId,
      intent: { kind: "transfer", amount: "1000000", asset: "USDC", counterparty: { address: PAYEE } },
    });
    expect(evaluated.outcome).toBe("deny");
    const x402 = await w.client.authorizeX402({
      payment_id: "pay_x402",
      org_id: w.org,
      agent_id: w.agent,
      account_id: w.accountId,
      account_address: w.account,
      chain_id: w.chain.chainId,
      spend_key_address: keys.spendKey.address,
      x402_domain: "api.example.com",
      pay_to: PAYEE,
      amount: "10000",
      asset: "USDC",
    });
    expect(x402.decision.outcome).toBe("deny");
    const health = await w.client.health();
    expect(health).toMatchObject({ status: "degraded", fail_closed: true });
    // Tightening still works while failing closed.
    await w.client.freeze({ scope: "agent", id: w.agent, reason: "incident" });
  });

  it("a database outage refuses with 503 and signs nothing", async () => {
    w = await World.create();
    const prepared = await w.prepare(w.transferCalls(PAYEE, usd(10), 0n));
    const request = w.cosignRequest(prepared, { to: PAYEE, amount: usd(10), fee: 0n });
    const sign = vi.spyOn(w.signer, "signHash");
    w.db.down = true;
    await expect(w.client.cosign(request)).rejects.toSatisfy(
      (e: unknown) => e instanceof AgentBankError && e.code === "cosigner_unavailable" && e.status === 503,
    );
    await expect(w.client.freeze({ scope: "agent", id: w.agent, reason: "x" })).rejects.toMatchObject({
      code: "cosigner_unavailable",
    });
    expect((await w.client.health()).checks.database).toBe("unavailable");
    expect(sign).not.toHaveBeenCalled();
    w.db.down = false;
    expect((await w.client.cosign(request)).decision.outcome).toBe("allow");
  });

  it("if recording fails after signing, the signature is discarded and nothing is spent", async () => {
    w = await World.create({ policy: { limits: { per_day: "15.00" } } });
    const prepared = await w.prepare(w.transferCalls(PAYEE, usd(10), 0n));
    const request = w.cosignRequest(prepared, { to: PAYEE, amount: usd(10), fee: 0n });
    const sign = vi.spyOn(w.signer, "signHash");
    w.db.failOn = /INSERT INTO audit_log/;
    await expect(w.client.cosign(request)).rejects.toMatchObject({ code: "cosigner_unavailable" });
    expect(sign).toHaveBeenCalledTimes(1);
    w.db.failOn = null;
    // Nothing was reserved: the full daily limit is still available.
    const retry = await w.client.cosign(request);
    expect(retry.decision.outcome).toBe("allow");
    expect((await w.pay(PAYEE, usd(5))).result.decision.outcome).toBe("allow");
    expect((await w.service.verifyAudit()).ok).toBe(true);
  });
});

describe("a compromised API cannot launder payments through identifiers", () => {
  let w: World;
  afterEach(async () => {
    await w.close();
  });

  it("an allowlisted agent id claimed for an attacker's address does not pass the allowlist", async () => {
    w = await World.create();
    const friend = newId("agent");
    await w.putPolicy(
      { ...DEFAULT_POLICY, counterparties: { mode: "allowlist", agent_ids: [friend] } },
      null,
    );
    const request = w.cosignRequest(await w.prepare(w.transferCalls(ATTACKER, usd(10), 0n)), {
      to: ATTACKER,
      amount: usd(10),
      fee: 0n,
    });
    request.intent.counterparty.agent_id = friend;
    const result = await expectRefused(w, request, "counterparties.allowlist");
    expect(
      result.decision.rule_hits.some((h) => h.rule === "cosigner.counterparty" && h.effect === "info"),
    ).toBe(true);
  });

  it("an agent id the co-signer knows at another address is refused outright", async () => {
    w = await World.create();
    // The co-signer knows agt_test's account; claiming agt_test for the attacker's address is a lie.
    const request = w.cosignRequest(await w.prepare(w.transferCalls(ATTACKER, usd(10), 0n)), {
      to: ATTACKER,
      amount: usd(10),
      fee: 0n,
    });
    request.intent.counterparty.agent_id = w.agent;
    await expectRefused(w, request, "cosigner.counterparty", /account is/);
  });

  it("a claimed identifier can only make a decision stricter (denylisted ERC-8004 id)", async () => {
    w = await World.create();
    await w.putPolicy(
      { ...DEFAULT_POLICY, counterparties: { mode: "denylist", erc8004_ids: ["eip155:1337:0xabc:7"] } },
      null,
    );
    const prepared = await w.prepare(w.transferCalls(PAYEE, usd(10), 0n));
    const request = w.cosignRequest(prepared, { to: PAYEE, amount: usd(10), fee: 0n });
    request.intent.counterparty.erc8004_id = "eip155:1337:0xabc:7";
    await expectRefused(w, request, "counterparties.denylist");
  });
});

describe("signatures returned are usable and bounded", () => {
  it("a refused operation cannot be pushed through with a forged co-signature", async () => {
    const w = await World.create();
    try {
      const prepared = await w.prepare(w.transferCalls(ATTACKER, usd(10), 0n));
      const forged = (await signOperationHash(keys.attacker, prepared.op.userOpHash)) as Hex;
      await expect(w.submit(prepared, forged)).rejects.toThrow();
      expect(w.chain.balanceOf(ATTACKER)).toBe(0n);
    } finally {
      await w.close();
    }
  });
});
