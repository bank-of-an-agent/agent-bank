import { getAddress } from "viem";
import { usdc } from "@agentbank/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onboardAgent, randomAccount, waitFor, type AgentWorld } from "../src/actors";
import { ownerExit, type ExitPositions, type ExitResult } from "../src/exit";
import { writePhase5Evidence, type ExitDrillEvidence } from "../src/exit-evidence";
import { suspenseBalance } from "../src/invariants";
import { startStack, type Stack } from "../src/stack";

/**
 * Phase 5 exit drill (simulated bank shutdown): fund an agent account with escrow, stream and
 * vault positions and a spend-key float, stop the services, and with only the owner key and the
 * chain withdraw everything to a cold wallet; then restart the indexer and show reconciliation
 * flagging the owner-initiated movements as unexplained. `gate:phase5` writes the evidence.
 */

const GATE = process.env.E2E_GATE === "phase5";
const FUNDED = usdc("1000");
const FLOAT = usdc("5");

let stack: Stack;
let evidence: ExitDrillEvidence;

beforeAll(async () => {
  const started = performance.now();
  stack = await startStack();
  const contracts = [
    stack.sim.contracts.escrow,
    stack.sim.contracts.streams,
    stack.sim.contracts.vaults,
  ].filter((x): x is `0x${string}` => Boolean(x));
  const world: AgentWorld = await onboardAgent(stack, {
    name: "exit",
    fund: FUNDED,
    spendFloat: FLOAT,
    scope: { allowed_contracts: contracts },
  });
  const account = getAddress(world.accountAddress);
  const coldWallet = randomAccount().address;
  const iso = (ms: number): string => new Date(stack.clock.nowMs() + ms).toISOString();

  // Escrow: lock $50 with a short expiry (1% fee, $1 minimum).
  const escrow = await world.agent.createEscrow(
    { payee: { address: randomAccount().address }, amount: "50.00", expiresAt: iso(120_000) },
    { waitForSettlement: true },
  );
  expect(escrow.status).toBe("locked");

  // Stream: pre-fund $100 at $0.01/s to a payee (0.5% fee).
  const streamPayee = randomAccount().address;
  const stream = await world.agent.createStream(
    { payee: { address: streamPayee }, amountPerInterval: "0.01", intervalSeconds: 1, deposit: "100.00" },
    { waitForSettlement: true },
  );
  expect(stream.status).toBe("active");

  // Locked vault: deposit $100, unlockable shortly (both are owner operations).
  let vault = await world.principal.vaults.create({
    account_id: world.accountId,
    kind: "locked",
    name: "runway",
    unlock_at: iso(120_000),
  });
  await world.principal.signOwnerOperation(vault.pending_operation_id as string, { wait: true });
  vault = await waitFor(
    stack,
    async () => {
      const v = await world.principal.vaults.retrieve(vault.id);
      return v.onchain_id ? v : undefined;
    },
    "vault on-chain",
  );
  const deposited = await world.principal.vaults.deposit(vault.id, {
    amount: { amount: "100.00", asset: "USDC" },
  });
  await world.principal.signOwnerOperation(deposited.pending_operation_id as string, { wait: true });
  await waitFor(
    stack,
    async () => stack.sim.getVault(BigInt(vault.onchain_id as string))?.balance === usdc("100"),
    "vault funded on-chain",
  );

  // Time passes: the escrow expires and the vault unlocks (the stream keeps accruing).
  stack.clock.advance(130_000);
  await stack.pump();

  const revenue = getAddress(stack.config.revenueAddress);
  const positions: ExitPositions = {
    escrow: { contract: getAddress(escrow.contract_address), onchainId: BigInt(escrow.onchain_id as string) },
    stream: { contract: getAddress(stream.contract_address), onchainId: BigInt(stream.onchain_id as string) },
    vault: {
      contract: getAddress(vault.contract_address as string),
      onchainId: BigInt(vault.onchain_id as string),
      amount: usdc("100"),
    },
    spendKey: getAddress(world.spendKeyAddress),
  };

  // --- shut the services down: stop the indexer/driver and touch nothing but the chain ---
  await stack.pauseDriver();

  const result: ExitResult = await ownerExit(stack, world.owner, account, coldWallet, positions);

  // Conservation: everything minted to the account's control, minus fees and the streamed-away
  // portion, must have reached the cold wallet.
  const feesToRevenue = stack.sim.balanceOf(revenue);
  const streamedAway = stack.sim.balanceOf(streamPayee);
  const recoverable = FUNDED + FLOAT - feesToRevenue - streamedAway;
  const leftBehind = recoverable - result.recovered;

  // --- restart the services: the indexer sees the owner's unexplained outflows ---
  stack.resumeDriver();
  // The big account → cold-wallet transfer is above the finality threshold and waits out the
  // 20-block matching window before it posts to suspense, so let suspense settle.
  await waitFor(
    stack,
    async () => ((await suspenseBalance(stack)) > 0n ? true : undefined),
    "owner exit flagged in suspense",
    60_000,
  );
  let suspenseAfterRestart = 0n;
  for (let stable = 0; stable < 8;) {
    await stack.pump();
    const s = await suspenseBalance(stack);
    if (s === suspenseAfterRestart) stable += 1;
    else {
      suspenseAfterRestart = s;
      stable = 0;
    }
  }
  const events = await world.principal.webhooks.listEvents({ type: "reconciliation.mismatch", limit: 50 });
  const agentPaused = events.data.some((e) => (e.data as { agent_paused?: boolean }).agent_paused === true);

  evidence = {
    result,
    funded: FUNDED,
    float: FLOAT,
    recoverable,
    leftBehind,
    streamedAway,
    feesToRevenue,
    suspenseAfterRestart,
    mismatchEvents: events.data.length,
    agentPaused,
    runtimeMs: performance.now() - started,
  };
  // Keep references for the assertions.
  Object.assign(evidence, { account, coldWallet, streamPayee });
  if (GATE) writePhase5Evidence(evidence);
}, 300_000);

afterAll(async () => {
  await stack.stopStack();
});

describe("Phase 5 owner exit drill", () => {
  it("recovers every recoverable unit to the owner's cold wallet with only the owner key", () => {
    expect(evidence.result.recovered).toBe(evidence.recoverable);
    expect(evidence.leftBehind).toBe(0n);
    expect(evidence.result.recovered).toBeGreaterThan(usdc("1000")); // escrow + vault + float + remainder
  });

  it("drains the account, escrow, stream, vault and spend key", () => {
    const { account } = evidence as unknown as { account: `0x${string}` };
    expect(stack.sim.balanceOf(account)).toBe(0n);
    expect(stack.sim.balanceOf(getAddress(stack.sim.contracts.escrow as `0x${string}`))).toBe(0n);
    expect(stack.sim.balanceOf(getAddress(stack.sim.contracts.streams as `0x${string}`))).toBe(0n);
    expect(stack.sim.balanceOf(getAddress(stack.sim.contracts.vaults as `0x${string}`))).toBe(0n);
  });

  it("runs every exit step with the owner key and the chain alone", () => {
    const steps = evidence.result.steps.map((s) => s.step);
    expect(steps).toEqual(
      expect.arrayContaining([
        "refund-escrow",
        "cancel-stream",
        "withdraw-vault",
        "sweep-float",
        "withdraw-usdc",
      ]),
    );
  });

  it("reconciliation flags the owner movements as unexplained after restart", () => {
    expect(evidence.suspenseAfterRestart).toBeGreaterThan(0n);
    expect(evidence.mismatchEvents).toBeGreaterThan(0);
    expect(evidence.agentPaused).toBe(true);
  });
});
