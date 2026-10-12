import {
  concatHex,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  size,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { erc20Abi, safe7579Abi, topUpExecutorAbi, topUpRuleInitParams } from "../abis";
import { MODE_SINGLE_DEFAULT } from "../erc7579";
import type { ExecutorModule } from "./accounts";
import { JMap } from "./journal";
import { DAY, emitLog, eventOf, key, revert, type ExecContext } from "./vm";
import type { World } from "./world";

const TOPPED_UP = eventOf(topUpExecutorAbi, "ToppedUp");
const RULE_SET = eventOf(topUpExecutorAbi, "RuleSet");
const RULE_REMOVED = eventOf(topUpExecutorAbi, "RuleRemoved");

/** A refill rule (`ITopUpExecutor.TopUpRule`). */
export interface SimTopUpRule {
  token: Address;
  refillTo: bigint;
  whenBelow: bigint;
  maxPerDay: bigint;
}

/** `TopUpExecutor` semantics (contracts/src/TopUpExecutor.sol). */
export class SimTopUp implements ExecutorModule {
  private readonly treasuries: JMap<string, { initialized: boolean; epoch: number }>;
  private readonly rules: JMap<string, SimTopUpRule>;
  private readonly windows: JMap<string, { day: bigint; spent: bigint }>;

  constructor(
    private readonly world: World,
    readonly address: Address,
    /** Calls `account.executeFromExecutor(mode, data)` as this executor. */
    private readonly executeFromExecutor: (
      ctx: ExecContext,
      executor: Address,
      account: Address,
      callData: Hex,
    ) => void,
  ) {
    this.treasuries = new JMap(world.journal);
    this.rules = new JMap(world.journal);
    this.windows = new JMap(world.journal);
  }

  private state(treasury: Address) {
    return this.treasuries.get(key(treasury)) ?? { initialized: false, epoch: 0 };
  }

  getRule(treasury: Address, agent: Address): SimTopUpRule | undefined {
    return this.rules.get(key(treasury, this.state(treasury).epoch, agent));
  }

  spentToday(treasury: Address, agent: Address, timestamp: number): bigint {
    const w = this.windows.get(key(treasury, this.state(treasury).epoch, agent));
    return w && w.day === BigInt(Math.floor(timestamp / DAY)) ? w.spent : 0n;
  }

  onInstall(ctx: ExecContext, treasury: Address, data: Hex): void {
    const st = this.state(treasury);
    if (st.initialized) revert(`AlreadyInitialized(${treasury})`);
    this.treasuries.set(key(treasury), { initialized: true, epoch: st.epoch });
    if (size(data) !== 0) {
      const [rules] = decodeAbiParameters(topUpRuleInitParams, data);
      for (const r of rules)
        this.setRule(ctx, treasury, st.epoch, getAddress(r.agent), {
          ...r.rule,
          token: getAddress(r.rule.token),
        });
    }
  }

  onUninstall(_ctx: ExecContext, treasury: Address): void {
    const st = this.state(treasury);
    if (!st.initialized) return;
    this.treasuries.set(key(treasury), { initialized: false, epoch: st.epoch + 1 });
  }

  private setRule(ctx: ExecContext, treasury: Address, epoch: number, agent: Address, r: SimTopUpRule): void {
    if (
      agent === zeroAddress ||
      agent === getAddress(treasury) ||
      agent === this.address ||
      agent === r.token
    ) {
      revert(`InvalidAgent(${agent})`);
    }
    if (
      r.token === zeroAddress ||
      r.token === getAddress(treasury) ||
      r.refillTo === 0n ||
      r.whenBelow === 0n ||
      r.whenBelow > r.refillTo ||
      r.maxPerDay === 0n
    ) {
      revert(`InvalidRule(${r.token}, ${r.refillTo}, ${r.whenBelow}, ${r.maxPerDay})`);
    }
    this.rules.set(key(treasury, epoch, agent), r);
    emitLog(ctx, this.address, RULE_SET, { treasury, agent, ...r });
  }

  private amountFor(treasury: Address, r: SimTopUpRule, balance: bigint, spent: bigint): bigint {
    const remainingToday = spent >= r.maxPerDay ? 0n : r.maxPerDay - spent;
    const need = r.refillTo - balance;
    const treasuryBalance = this.world.balanceOf(r.token, treasury);
    return [need, remainingToday, treasuryBalance].reduce((a, b) => (a < b ? a : b));
  }

  /** What `topUp(treasury, agent)` would transfer now (0 if it would revert). */
  preview(treasury: Address, agent: Address, timestamp: number): bigint {
    const st = this.state(treasury);
    if (!st.initialized) return 0n;
    const r = this.getRule(treasury, agent);
    if (!r) return 0n;
    const balance = this.world.balanceOf(r.token, agent);
    if (balance >= r.whenBelow) return 0n;
    return this.amountFor(treasury, r, balance, this.spentToday(treasury, agent, timestamp));
  }

  topUp(ctx: ExecContext, treasury: Address, agent: Address): bigint {
    const st = this.state(treasury);
    if (!st.initialized) revert(`NotInitialized(${treasury})`);
    const r = this.rules.get(key(treasury, st.epoch, agent));
    if (!r) revert(`RuleNotFound(${treasury}, ${agent})`);
    const balance = this.world.balanceOf(r.token, agent);
    if (balance >= r.whenBelow) revert(`NotBelowThreshold(${agent}, ${balance}, ${r.whenBelow})`);
    const spent = this.spentToday(treasury, agent, ctx.timestamp);
    const amount = this.amountFor(treasury, r, balance, spent);
    if (amount === 0n) revert(`NothingToTopUp(${treasury}, ${agent})`);
    this.windows.set(key(treasury, st.epoch, agent), {
      day: BigInt(Math.floor(ctx.timestamp / DAY)),
      spent: spent + amount,
    });
    emitLog(ctx, this.address, TOPPED_UP, { treasury, agent, amount });
    const execution = concatHex([
      r.token,
      toHex(0n, { size: 32 }),
      encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [agent, amount] }),
    ]);
    this.executeFromExecutor(
      ctx,
      this.address,
      treasury,
      encodeFunctionData({
        abi: safe7579Abi,
        functionName: "executeFromExecutor",
        args: [MODE_SINGLE_DEFAULT, execution],
      }),
    );
    const received = this.world.balanceOf(r.token, agent) - balance;
    if (received !== amount) revert(`TopUpAmountMismatch(${amount}, ${received})`);
    return amount;
  }

  handle(ctx: ExecContext, from: Address, data: Hex): Hex {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: topUpExecutorAbi, data });
    } catch {
      revert("TopUpExecutor: unsupported function");
    }
    const a = decoded.args as readonly unknown[];
    switch (decoded.functionName) {
      case "topUp":
        return encodeAbiParameters(
          [{ type: "uint256" }],
          [this.topUp(ctx, getAddress(a[0] as Address), getAddress(a[1] as Address))],
        );
      case "setRule": {
        const st = this.state(from);
        if (!st.initialized) revert(`NotInitialized(${from})`);
        this.setRule(ctx, from, st.epoch, getAddress(a[0] as Address), {
          token: getAddress(a[1] as Address),
          refillTo: a[2] as bigint,
          whenBelow: a[3] as bigint,
          maxPerDay: a[4] as bigint,
        });
        return "0x";
      }
      case "removeRule": {
        const st = this.state(from);
        if (!st.initialized) revert(`NotInitialized(${from})`);
        const agent = getAddress(a[0] as Address);
        if (!this.rules.get(key(from, st.epoch, agent))) revert(`RuleNotFound(${from}, ${agent})`);
        this.rules.delete(key(from, st.epoch, agent));
        emitLog(ctx, this.address, RULE_REMOVED, { treasury: from, agent });
        return "0x";
      }
      default:
        return revert(`TopUpExecutor: ${decoded.functionName} is a view; read it from the gateway`);
    }
  }
}
