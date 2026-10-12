import { usdc } from "@agentbank/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundAddress, onboardAgent, randomAccount, type AgentWorld } from "../src/actors";
import { baseSepoliaInstructions, missingBaseSepoliaEnv, wantsBaseSepolia } from "../src/base-sepolia";
import { assertGlobalInvariants } from "../src/invariants";
import { startStack, type Stack } from "../src/stack";

/**
 * Phase 3 gate as written: "end-to-end suite on Base Sepolia passes". The same scenario helpers
 * drive the stack against the real testnet when `E2E_CHAIN=base-sepolia` and a human has supplied
 * the RPC URL, a Pimlico key, funded testnet keys and the deployed contract addresses. Otherwise
 * it is skipped with a message listing exactly what to provide — nothing is ever broadcast.
 */

const RUN = wantsBaseSepolia();
const MISSING = RUN ? missingBaseSepoliaEnv() : [];

describe("Phase 3 Base Sepolia end-to-end gate", () => {
  if (!RUN) {
    it("is skipped unless E2E_CHAIN=base-sepolia (prints what a human must provide)", () => {
      console.warn(`\n${baseSepoliaInstructions()}\n`);
      expect(wantsBaseSepolia()).toBe(false);
    });
    return;
  }

  it("has every required credential before broadcasting anything", () => {
    expect(MISSING, `missing Base Sepolia configuration:\n${baseSepoliaInstructions()}`).toEqual([]);
  });

  describe.skipIf(MISSING.length > 0)("live scenario", () => {
    let stack: Stack;
    let world: AgentWorld;

    beforeAll(async () => {
      stack = await startStack({ chain: "base-sepolia" });
      world = await onboardAgent(stack, { name: "base-sepolia" });
    }, 600_000);

    afterAll(async () => {
      await stack?.stopStack();
    });

    it("onboards, funds, pays an external address and reconciles", async () => {
      await fundAddress(stack, world.accountAddress, usdc("5"));
      const external = randomAccount().address;
      const payment = await world.agent.pay(
        { to: external, amount: "1.00", memo: "base-sepolia e2e" },
        { waitForSettlement: true, timeoutMs: 300_000 },
      );
      expect(payment.status).toBe("settled");
      expect(await stack.balanceOf(external)).toBe(usdc("1"));
      await assertGlobalInvariants(stack, "base-sepolia payment");
    }, 600_000);
  });
});
