import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Address } from "viem";
import { ManualClock } from "@agentbank/core";
import { erc20Abi, transferCall } from "../src";
import { SimulatedChain } from "../src/simulated";
import { otherPayee, payee, revenue, setupAgent, stranger, submitAsSession, USDC } from "./helpers";

const transferData = (to: Address, amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });

describe("SimulatedChain: blocks, time and finality", () => {
  it("mines blocks with increasing timestamps and resolves latest/safe/finalized", async () => {
    const chain = new SimulatedChain({ safeDepth: 2, finalityDepth: 5 });
    const gw = chain.gateway;
    const genesis = await gw.getBlock(0n);
    expect(genesis.number).toBe(0n);
    chain.mine(10);
    const latest = await gw.getBlock("latest");
    expect(latest.number).toBe(10n);
    expect((await gw.getBlock("safe")).number).toBe(8n);
    expect((await gw.getBlock("finalized")).number).toBe(5n);
    expect(latest.timestamp - genesis.timestamp).toBe(20);
    const b9 = await gw.getBlock(9n);
    expect(latest.parentHash).toBe(b9.hash);
    chain.advanceTime(3600);
    const [next] = chain.mine();
    expect(next?.timestamp).toBe(latest.timestamp + 2 + 3600);
    await expect(gw.getBlock(100n)).rejects.toMatchObject({ code: "not_found" });
  });

  it("follows a shared ManualClock (blocks at least one second apart)", () => {
    const clock = new ManualClock("2026-10-12T00:00:00Z");
    const chain = new SimulatedChain({ clock });
    const t0 = chain.head.timestamp;
    expect(t0).toBe(Math.floor(Date.parse("2026-10-12T00:00:00Z") / 1000));
    chain.mine(3);
    expect(chain.head.timestamp).toBe(t0 + 3);
    clock.advanceSeconds(100);
    chain.mine();
    expect(chain.head.timestamp).toBe(t0 + 100);
    chain.advanceTime(50); // advances the shared clock
    expect(clock.now().getTime() / 1000).toBe(t0 + 150);
  });

  it("is deterministic: identical histories give identical block hashes", async () => {
    const run = async () => {
      const chain = new SimulatedChain();
      const { account, permissionId } = await setupAgent(chain);
      const op = await chain.gateway.prepareOperation({
        account,
        session: { permissionId },
        calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount: USDC(5) })],
      });
      await submitAsSession(chain.gateway, op);
      return chain.head.hash;
    };
    expect(await run()).toBe(await run());
  });

  it("holds transactions in a pool when automine is off", async () => {
    const chain = new SimulatedChain({ automine: false });
    const { account, permissionId } = await (async () => {
      chain.automine = true;
      const r = await setupAgent(chain);
      chain.automine = false;
      return r;
    })();
    const op = await chain.gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount: USDC(5) })],
    });
    const { userOpHash } = await submitAsSession(chain.gateway, op);
    expect((await chain.gateway.getOperationReceipt(userOpHash)).status).toBe("pending");
    expect(chain.pendingCount).toBe(1);
    chain.mine();
    const receipt = await chain.gateway.getOperationReceipt(userOpHash);
    expect(receipt.status).toBe("succeeded");
    expect(receipt.blockNumber).toBe(chain.head.number);
  });
});

describe("SimulatedChain: logs and balances", () => {
  it("filters logs by address, event and party", async () => {
    const chain = new SimulatedChain();
    const { account, permissionId } = await setupAgent(chain);
    const usdc = chain.contracts.usdc;
    const op = await chain.gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: [
        transferCall({ token: usdc, to: payee, amount: USDC(5) }),
        transferCall({ token: usdc, to: revenue, amount: 10_000n }),
      ],
    });
    const { userOpHash } = await submitAsSession(chain.gateway, op);
    chain.faucet(otherPayee, USDC(1));
    const head = chain.head.number;
    const all = await chain.gateway.getLogs({ fromBlock: 0n, toBlock: head });
    const names = all.map((l) => l.eventName);
    expect(names).toContain("SessionCreated");
    expect(names).toContain("AccountDeployed");
    expect(names.filter((n) => n === "UserOperationEvent")).toHaveLength(2);
    // Canonical order.
    for (let i = 1; i < all.length; i++) {
      const [a, b] = [all[i - 1]!, all[i]!];
      expect(
        a.blockNumber < b.blockNumber || (a.blockNumber === b.blockNumber && a.logIndex < b.logIndex),
      ).toBe(true);
    }
    const transfers = await chain.gateway.getLogs({
      fromBlock: 0n,
      toBlock: head,
      events: ["Transfer"],
      involving: [account],
    });
    expect(transfers.map((l) => [l.args.from, l.args.to])).toEqual([
      ["0x0000000000000000000000000000000000000000", account],
      [account, payee],
      [account, revenue],
    ]);
    const ops = await chain.gateway.getLogs({
      fromBlock: 0n,
      toBlock: head,
      events: ["UserOperationEvent"],
      involving: [account],
    });
    expect(ops.at(-1)?.args).toMatchObject({ userOpHash, sender: account, success: "true" });
    const onlyEntryPoint = await chain.gateway.getLogs({
      fromBlock: 0n,
      toBlock: head,
      addresses: [chain.contracts.entryPoint],
    });
    expect(new Set(onlyEntryPoint.map((l) => l.address))).toEqual(new Set([chain.contracts.entryPoint]));
    expect(
      await chain.gateway.getLogs({ fromBlock: 0n, toBlock: head, involving: [stranger.address] }),
    ).toEqual([]);
    await expect(chain.gateway.getLogs({ fromBlock: 5n, toBlock: 4n })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("answers balances at past blocks", async () => {
    const chain = new SimulatedChain();
    const usdc = chain.contracts.usdc;
    chain.faucet(stranger.address, USDC(10));
    const b1 = chain.head.number;
    chain.sendTransaction({ from: stranger.address, to: usdc, data: transferData(payee, USDC(4)) });
    const b2 = chain.head.number;
    chain.mine(3);
    const gw = chain.gateway;
    expect(await gw.getTokenBalance(usdc, stranger.address, 0n)).toBe(0n);
    expect(await gw.getTokenBalance(usdc, stranger.address, b1)).toBe(USDC(10));
    expect(await gw.getTokenBalance(usdc, stranger.address, b2)).toBe(USDC(6));
    expect(await gw.getTokenBalance(usdc, stranger.address)).toBe(USDC(6));
    expect(await gw.getTokenBalance(usdc, payee, b2 - 1n)).toBe(0n);
    await expect(gw.getTokenBalance(usdc, payee, chain.head.number + 1n)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("includes reverted EOA transactions without effects", () => {
    const chain = new SimulatedChain();
    const hash = chain.sendTransaction({
      from: stranger.address,
      to: chain.contracts.usdc,
      data: transferData(payee, 1n),
    });
    expect(chain.transaction(hash)).toMatchObject({
      success: false,
      revertReason: "ERC20: transfer amount exceeds balance",
      logs: [],
    });
  });
});

describe("SimulatedChain: reorgs", () => {
  it("replaces blocks with new hashes and re-emits the same logs (same tx hash and order)", async () => {
    const chain = new SimulatedChain();
    chain.faucet(stranger.address, USDC(10));
    const tx = chain.sendTransaction({
      from: stranger.address,
      to: chain.contracts.usdc,
      data: transferData(payee, USDC(4)),
    });
    const before = await chain.gateway.getLogs({
      fromBlock: 0n,
      toBlock: chain.head.number,
      events: ["Transfer"],
    });
    const oldHead = chain.head;
    const result = chain.injectReorg(2);
    expect(result.removed.map((b) => b.hash)).not.toContain(chain.head.hash);
    expect(result.added).toHaveLength(2);
    expect(chain.head.number).toBe(oldHead.number);
    expect(chain.head.hash).not.toBe(oldHead.hash);
    expect(result.dropped).toEqual([]);
    const after = await chain.gateway.getLogs({
      fromBlock: 0n,
      toBlock: chain.head.number,
      events: ["Transfer"],
    });
    expect(after.map((l) => [l.txHash, l.logIndex, l.args.value])).toEqual(
      before.map((l) => [l.txHash, l.logIndex, l.args.value]),
    );
    expect(after.map((l) => l.blockHash)).not.toEqual(before.map((l) => l.blockHash));
    expect(chain.transaction(tx)?.success).toBe(true);
    expect(chain.balanceOf(payee)).toBe(USDC(4));
  });

  it("dropping transactions removes their effects, logs and receipts; requeued ones come back", async () => {
    const chain = new SimulatedChain({ finalityDepth: 20 });
    const { account, permissionId } = await setupAgent(chain);
    const op = await chain.gateway.prepareOperation({
      account,
      session: { permissionId },
      calls: [transferCall({ token: chain.contracts.usdc, to: payee, amount: USDC(5) })],
    });
    const { userOpHash } = await submitAsSession(chain.gateway, op);
    const receipt = await chain.gateway.getOperationReceipt(userOpHash);
    const balanceBlock = chain.head.number;
    const r = chain.injectReorg(1, { drop: [receipt.txHash!] });
    expect(r.dropped).toEqual([receipt.txHash]);
    expect((await chain.gateway.getOperationReceipt(userOpHash)).status).toBe("not_found");
    expect(chain.balanceOf(payee)).toBe(0n);
    expect(await chain.gateway.getTokenBalance(chain.contracts.usdc, payee, balanceBlock)).toBe(0n);
    expect(
      await chain.gateway.getLogs({ fromBlock: 0n, toBlock: chain.head.number, involving: [payee] }),
    ).toEqual([]);
    // The bundler can resubmit it: it is valid again.
    await submitAsSession(chain.gateway, op);
    expect((await chain.gateway.getOperationReceipt(userOpHash)).status).toBe("succeeded");
    expect(chain.balanceOf(payee)).toBe(USDC(5));

    const r2 = chain.injectReorg(1, { drop: "all", requeue: true });
    expect(r2.dropped).toHaveLength(1);
    expect((await chain.gateway.getOperationReceipt(userOpHash)).status).toBe("pending");
    chain.mine();
    expect((await chain.gateway.getOperationReceipt(userOpHash)).status).toBe("succeeded");
  });

  it("reordering can invalidate dependent transactions", () => {
    const chain = new SimulatedChain({ finalityDepth: 20 });
    const usdc = chain.contracts.usdc;
    const fund = chain.faucet(stranger.address, USDC(10));
    const spend = chain.sendTransaction({
      from: stranger.address,
      to: usdc,
      data: transferData(payee, USDC(10)),
    });
    expect(chain.transaction(spend)?.success).toBe(true);
    chain.injectReorg(2, { order: "reverse" });
    expect(chain.transaction(spend)?.success).toBe(false);
    expect(chain.transaction(fund)?.success).toBe(true);
    expect(chain.balanceOf(payee)).toBe(0n);
    expect(chain.balanceOf(stranger.address)).toBe(USDC(10));
  });

  it("never reorgs finalized blocks and keeps working after many blocks", () => {
    const chain = new SimulatedChain({ finalityDepth: 4 });
    chain.mine(50);
    expect(() => chain.injectReorg(5)).toThrow(/cannot reorg/);
    const r = chain.injectReorg(4, { blocks: 6 });
    expect(r.added).toHaveLength(6);
    expect(chain.head.number).toBe(52n);
  });
});
