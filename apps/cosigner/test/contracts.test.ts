import {
  escrowLockCalls,
  SIMULATED_CONTRACTS,
  streamCreateCalls,
  streamTopUpCalls,
  transferCall,
  type Call,
} from "@agentbank/chain";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAYEE, REVENUE, usd, World } from "./helpers";

const escrow = SIMULATED_CONTRACTS.escrow as Address;
const streams = SIMULATED_CONTRACTS.streams as Address;
let w: World;

beforeAll(async () => {
  w = await World.create({ scope: { allowed_contracts: [escrow, streams] } });
});

afterAll(async () => {
  await w.close();
});

function withFee(calls: Call[], fee: bigint): Call[] {
  return [...calls, transferCall({ token: w.usdc, to: REVENUE, amount: fee })];
}

function lockCalls(amount: bigint): Call[] {
  return escrowLockCalls({
    escrow,
    token: w.usdc,
    payee: PAYEE,
    amount,
    expiresAt: BigInt(w.now() + 86_400),
    termsHash: keccak256(toHex("deliver the report")),
  });
}

describe("escrow and streams", () => {
  it("co-signs an escrow lock (approval + lock + fee) that executes on-chain", async () => {
    const prepared = await w.prepare(withFee(lockCalls(usd(20)), usd(1)));
    const request = w.cosignRequest(prepared, { to: PAYEE, amount: usd(20), fee: usd(1), kind: "escrow" });
    request.intent.counterparty.contract = escrow;
    const result = await w.client.cosign(request);
    expect(result.decision.outcome).toBe("allow");
    expect(result.decision.rule_hits).toContainEqual(
      expect.objectContaining({ rule: "session.allowed_contracts", effect: "allow" }),
    );
    const receipt = await w.submit(prepared, result.signature as Hex);
    expect(receipt.status).toBe("succeeded");
    expect(w.chain.balanceOf(escrow)).toBe(usd(20));
    expect(w.chain.balanceOf(REVENUE)).toBe(usd(1));
  });

  it("co-signs a stream creation that executes on-chain", async () => {
    const calls = streamCreateCalls({
      streams,
      token: w.usdc,
      payee: PAYEE,
      deposit: usd(10),
      amountPerInterval: usd(1),
      interval: 3600n,
    });
    const prepared = await w.prepare(withFee(calls, usd(0.05)));
    const result = await w.client.cosign(
      w.cosignRequest(prepared, { to: PAYEE, amount: usd(10), fee: usd(0.05), kind: "stream" }),
    );
    expect(result.decision.outcome).toBe("allow");
    expect((await w.submit(prepared, result.signature as Hex)).status).toBe("succeeded");
    expect(w.chain.balanceOf(streams)).toBe(usd(10));
  });

  it("refuses an escrow whose stated contract or payee differs from the operation", async () => {
    const prepared = await w.prepareOrCraft(lockCalls(usd(5)));
    const wrongContract = w.cosignRequest(prepared, { to: PAYEE, amount: usd(5), fee: 0n, kind: "escrow" });
    wrongContract.intent.counterparty.contract = streams;
    const refused = await w.client.cosign(wrongContract);
    expect(refused.signature).toBeNull();
    expect(refused.decision.rule_hits).toContainEqual(
      expect.objectContaining({ rule: "cosigner.intent_mismatch" }),
    );
    const elsewhere = "0x000000000000000000000000000000000000c0de" as Address;
    const wrongPayee = await w.client.cosign(
      w.cosignRequest(await w.prepareOrCraft(lockCalls(usd(5))), {
        to: elsewhere,
        amount: usd(5),
        fee: 0n,
        kind: "escrow",
      }),
    );
    expect(wrongPayee.signature).toBeNull();
    expect(wrongPayee.decision.rule_hits).toContainEqual(
      expect.objectContaining({ rule: "cosigner.intent_mismatch" }),
    );
  });

  it("refuses stream top-ups, whose payee the calldata does not show", async () => {
    const calls = streamTopUpCalls({ streams, token: w.usdc, streamId: 1n, amount: usd(5) });
    const result = await w.client.cosign(
      w.cosignRequest(await w.prepareOrCraft(calls), { to: PAYEE, amount: usd(5), fee: 0n, kind: "stream" }),
    );
    expect(result.signature).toBeNull();
    expect(result.decision.rule_hits).toContainEqual(
      expect.objectContaining({ rule: "cosigner.intent_mismatch" }),
    );
  });
});

describe("session contract scope", () => {
  it("refuses contracts outside the session's allowed_contracts", async () => {
    const narrow = await World.create({ scope: { allowed_contracts: [escrow] } });
    try {
      const calls = streamCreateCalls({
        streams,
        token: narrow.usdc,
        payee: PAYEE,
        deposit: usd(10),
        amountPerInterval: usd(1),
        interval: 3600n,
      });
      const result = await narrow.client.cosign(
        narrow.cosignRequest(await narrow.prepareOrCraft(calls), {
          to: PAYEE,
          amount: usd(10),
          fee: 0n,
          kind: "stream",
        }),
      );
      expect(result.signature).toBeNull();
      expect(result.decision.rule_hits).toContainEqual(
        expect.objectContaining({ rule: "session.allowed_contracts", effect: "deny" }),
      );
    } finally {
      await narrow.close();
    }
  });
});
