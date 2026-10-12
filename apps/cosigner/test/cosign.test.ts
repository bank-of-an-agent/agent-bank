import { signOperationHash } from "@agentbank/chain";
import { CosignResultInternal, verifyAuditChain } from "@agentbank/core";
import { recoverMessageAddress, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { keys, PAYEE, REVENUE, usd, World } from "./helpers";

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function setup(options?: Parameters<typeof World.create>[0]): Promise<World> {
  world = await World.create(options);
  return world;
}

describe("cosign happy path", () => {
  it("co-signs a transfer that matches its intent, and the 2-of-2 operation executes on-chain", async () => {
    const w = await setup();
    const { prepared, request, result } = await w.pay(PAYEE, usd(25), usd(0.05));
    expect(CosignResultInternal.parse(result)).toEqual(result);
    expect(result.decision.outcome).toBe("allow");
    expect(result.decision.id).toMatch(/^dec_/);
    expect(result.cosigner_address).toBe(w.signer.address);
    const signature = result.signature as Hex;
    expect(await recoverMessageAddress({ message: { raw: request.user_op_hash as Hex }, signature })).toBe(
      w.signer.address,
    );

    const receipt = await w.submit(prepared, signature);
    expect(receipt.status).toBe("succeeded");
    expect(w.chain.balanceOf(PAYEE)).toBe(usd(25));
    expect(w.chain.balanceOf(REVENUE)).toBe(usd(0.05));

    const audit = await w.client.audit();
    expect(verifyAuditChain(audit.records as never)).toBe(-1);
    const signed = audit.records.find((r) => r.action === "cosign.signed");
    expect(signed?.subject).toBe(request.payment_id);
    expect((signed?.payload as { signature: string }).signature).toBe(signature);
  });

  it("is idempotent per payment: an identical retry returns the same signature without double-counting", async () => {
    const w = await setup({ policy: { limits: { per_day: "30.00" } } });
    const first = await w.pay(PAYEE, usd(20));
    const retry = await w.client.cosign(first.request);
    expect(retry.signature).toBe(first.result.signature);
    expect(retry.decision.id).toBe(first.result.decision.id);
    // Only 20 of the 30 daily limit is used, so 10 more fits and 11 does not.
    expect((await w.pay(PAYEE, usd(10))).result.decision.outcome).toBe("allow");
    expect((await w.pay(PAYEE, usd(0.01))).result.decision.outcome).toBe("deny");
  });

  it("without the co-signature the session key alone cannot move funds", async () => {
    const w = await setup();
    const prepared = await w.prepare(w.transferCalls(PAYEE, usd(5), 0n));
    const forged = await signOperationHash(keys.attacker, prepared.op.userOpHash);
    await expect(w.submit(prepared, forged)).rejects.toThrow();
    expect(w.chain.balanceOf(PAYEE)).toBe(0n);
  });
});
