import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { erc20Abi, paymentStreamsAbi } from "../abis";
import { JMap } from "./journal";
import { check, emitLog, eventOf, key, revert, SimRevert, type ExecContext } from "./vm";
import type { World } from "./world";

const CREATED = eventOf(paymentStreamsAbi, "StreamCreated");
const TOPPED_UP = eventOf(paymentStreamsAbi, "StreamToppedUp");
const SETTLED = eventOf(paymentStreamsAbi, "StreamSettled");
const CANCELED = eventOf(paymentStreamsAbi, "StreamCanceled");
const DEFERRED = eventOf(paymentStreamsAbi, "StreamSettlementDeferred");

const UINT128_MAX = 2n ** 128n - 1n;

/** One stream (mirrors `IPaymentStreams.Stream`). */
export interface SimStreamRecord {
  id: bigint;
  payer: Address;
  payee: Address;
  token: Address;
  start: bigint;
  stop: bigint;
  interval: bigint;
  amountPerInterval: bigint;
  deposit: bigint;
  paid: bigint;
  refunded: bigint;
  canceled: boolean;
}

/** `PaymentStreams` semantics (contracts/src/PaymentStreams.sol). */
export class SimStreams {
  private readonly streams: JMap<string, SimStreamRecord>;
  private readonly counters: JMap<string, bigint>;

  constructor(
    private readonly world: World,
    readonly address: Address,
  ) {
    this.streams = new JMap(world.journal);
    this.counters = new JMap(world.journal);
  }

  get(id: bigint): SimStreamRecord | undefined {
    return this.streams.get(id.toString());
  }

  count(): bigint {
    return this.counters.get("count") ?? 0n;
  }

  totalOutstanding(token: Address): bigint {
    return this.counters.get(key("outstanding", token)) ?? 0n;
  }

  private addOutstanding(token: Address, delta: bigint): void {
    this.counters.set(key("outstanding", token), this.totalOutstanding(token) + delta);
  }

  private existing(id: bigint): SimStreamRecord {
    const s = this.get(id);
    if (!s) revert(`StreamNotFound(${id})`);
    return s;
  }

  /** `min(deposit, floor((min(t, stop) - start) / interval) * amountPerInterval)`, 0 before start. */
  accruedAt(s: SimStreamRecord, t: bigint): bigint {
    let end = t;
    if (s.stop !== 0n && s.stop < end) end = s.stop;
    if (end <= s.start) return 0n;
    const earned = ((end - s.start) / s.interval) * s.amountPerInterval;
    return earned < s.deposit ? earned : s.deposit;
  }

  settleable(id: bigint, t: bigint): bigint {
    const s = this.existing(id);
    return this.accruedAt(s, t) - s.paid;
  }

  private tokenCall(ctx: ExecContext, token: Address, data: Hex): void {
    this.world.call(ctx, this.address, token, 0n, data);
  }

  createStream(
    ctx: ExecContext,
    payer: Address,
    p: {
      token: Address;
      payee: Address;
      deposit: bigint;
      amountPerInterval: bigint;
      interval: bigint;
      start: bigint;
      stop: bigint;
    },
  ): bigint {
    const now = BigInt(ctx.timestamp);
    check(p.token !== zeroAddress, "ZeroAddress()");
    if (p.payee === zeroAddress || p.payee === payer || p.payee === this.address)
      revert(`InvalidPayee(${p.payee})`);
    if (p.deposit === 0n || p.deposit > UINT128_MAX) revert(`InvalidAmount(${p.deposit})`);
    if (p.amountPerInterval === 0n || p.amountPerInterval > UINT128_MAX)
      revert(`InvalidRate(${p.amountPerInterval})`);
    check(p.interval !== 0n, "InvalidInterval()");
    const start = p.start === 0n ? now : p.start;
    if (start < now) revert(`InvalidStart(${p.start})`);
    if (p.stop !== 0n && p.stop <= start) revert(`InvalidStop(${p.stop})`);
    const id = this.count() + 1n;
    this.counters.set("count", id);
    this.streams.set(id.toString(), {
      id,
      payer: getAddress(payer),
      payee: getAddress(p.payee),
      token: getAddress(p.token),
      start,
      stop: p.stop,
      interval: p.interval,
      amountPerInterval: p.amountPerInterval,
      deposit: p.deposit,
      paid: 0n,
      refunded: 0n,
      canceled: false,
    });
    this.addOutstanding(p.token, p.deposit);
    emitLog(ctx, this.address, CREATED, {
      id,
      payer,
      payee: p.payee,
      token: p.token,
      deposit: p.deposit,
      amountPerInterval: p.amountPerInterval,
      interval: p.interval,
      start,
      stop: p.stop,
    });
    this.tokenCall(
      ctx,
      p.token,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "transferFrom",
        args: [payer, this.address, p.deposit],
      }),
    );
    return id;
  }

  topUp(ctx: ExecContext, caller: Address, id: bigint, amount: bigint): void {
    const s = this.existing(id);
    if (getAddress(caller) !== s.payer) revert(`Unauthorized(${caller})`);
    if (s.canceled) revert(`StreamIsCanceled(${id})`);
    if (s.stop !== 0n && BigInt(ctx.timestamp) >= s.stop) revert(`StreamEnded(${id}, ${s.stop})`);
    if (amount === 0n) revert("InvalidAmount(0)");
    const newDeposit = s.deposit + amount;
    if (newDeposit > UINT128_MAX) revert(`DepositOverflow(${newDeposit})`);
    this.streams.set(id.toString(), { ...s, deposit: newDeposit });
    this.addOutstanding(s.token, amount);
    emitLog(ctx, this.address, TOPPED_UP, { id, payer: caller, amount, newDeposit });
    this.tokenCall(
      ctx,
      s.token,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "transferFrom",
        args: [caller, this.address, amount],
      }),
    );
  }

  settle(ctx: ExecContext, caller: Address, id: bigint): bigint {
    const s = this.existing(id);
    const accruedNow = this.accruedAt(s, BigInt(ctx.timestamp));
    const amount = accruedNow - s.paid;
    if (amount === 0n) return 0n;
    this.streams.set(id.toString(), { ...s, paid: accruedNow });
    this.addOutstanding(s.token, -amount);
    emitLog(ctx, this.address, SETTLED, { id, payee: s.payee, caller, token: s.token, amount });
    this.tokenCall(
      ctx,
      s.token,
      encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.payee, amount] }),
    );
    return amount;
  }

  cancel(ctx: ExecContext, caller: Address, id: bigint): { payeeAmount: bigint; refundAmount: bigint } {
    const s = this.existing(id);
    const c = getAddress(caller);
    if (c !== s.payer && c !== s.payee) revert(`Unauthorized(${caller})`);
    if (s.canceled) revert(`StreamIsCanceled(${id})`);
    const now = BigInt(ctx.timestamp);
    const accruedNow = this.accruedAt(s, now);
    const frozenAt = now < s.start ? s.start : now;
    const stop = s.stop === 0n || s.stop > frozenAt ? frozenAt : s.stop;
    const refundAmount = s.deposit - accruedNow;
    let record: SimStreamRecord = { ...s, stop, canceled: true, refunded: refundAmount };
    this.addOutstanding(s.token, -refundAmount);
    let payeeAmount = 0n;
    const owed = accruedNow - s.paid;
    if (owed !== 0n) {
      record = { ...record, paid: accruedNow };
      this.streams.set(id.toString(), record);
      this.addOutstanding(s.token, -owed);
      // trySafeTransfer: a failed payee transfer is rolled back and deferred, never blocking the refund.
      const mark = ctx.journal.mark();
      try {
        this.tokenCall(
          ctx,
          s.token,
          encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.payee, owed] }),
        );
        payeeAmount = owed;
        emitLog(ctx, this.address, SETTLED, { id, payee: s.payee, caller, token: s.token, amount: owed });
      } catch (error) {
        if (!(error instanceof SimRevert)) throw error;
        ctx.journal.revertTo(mark);
        record = { ...record, paid: s.paid };
        this.addOutstanding(s.token, owed);
        emitLog(ctx, this.address, DEFERRED, { id, payee: s.payee, amount: owed });
      }
    }
    this.streams.set(id.toString(), record);
    emitLog(ctx, this.address, CANCELED, {
      id,
      canceledBy: caller,
      token: s.token,
      payeeAmount,
      refundAmount,
    });
    if (refundAmount !== 0n) {
      this.tokenCall(
        ctx,
        s.token,
        encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.payer, refundAmount] }),
      );
    }
    return { payeeAmount, refundAmount };
  }

  handle(ctx: ExecContext, from: Address, data: Hex): Hex {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: paymentStreamsAbi, data });
    } catch {
      revert("PaymentStreams: unsupported function");
    }
    const a = decoded.args as readonly unknown[];
    switch (decoded.functionName) {
      case "createStream": {
        const id = this.createStream(ctx, from, {
          token: getAddress(a[0] as Address),
          payee: getAddress(a[1] as Address),
          deposit: a[2] as bigint,
          amountPerInterval: a[3] as bigint,
          interval: a[4] as bigint,
          start: a[5] as bigint,
          stop: a[6] as bigint,
        });
        return encodeAbiParameters([{ type: "uint256" }], [id]);
      }
      case "topUp":
        this.topUp(ctx, from, a[0] as bigint, a[1] as bigint);
        return "0x";
      case "settle":
        return encodeAbiParameters([{ type: "uint256" }], [this.settle(ctx, from, a[0] as bigint)]);
      case "cancel": {
        const r = this.cancel(ctx, from, a[0] as bigint);
        return encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint256" }],
          [r.payeeAmount, r.refundAmount],
        );
      }
      default:
        return revert(`PaymentStreams: ${decoded.functionName} is a view; read it from the gateway`);
    }
  }
}
