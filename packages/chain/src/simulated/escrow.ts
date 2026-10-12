import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import type { ESCROW_STATUS } from "../abis";
import {
  agentEscrowAbi,
  erc20Abi,
  ESCROW_DISPUTE_TIMEOUT_SECONDS,
  ESCROW_MAX_DURATION_SECONDS,
} from "../abis";
import { JMap } from "./journal";
import { check, emitLog, eventOf, key, revert, type ExecContext } from "./vm";
import type { World } from "./world";

const LOCKED = eventOf(agentEscrowAbi, "Locked");
const VALIDATION_CONFIGURED = eventOf(agentEscrowAbi, "ValidationConfigured");
const RELEASED = eventOf(agentEscrowAbi, "Released");
const REFUNDED = eventOf(agentEscrowAbi, "Refunded");
const DISPUTED = eventOf(agentEscrowAbi, "Disputed");
const RESOLVED = eventOf(agentEscrowAbi, "Resolved");

type Status = (typeof ESCROW_STATUS)[number];

/** One escrow (mirrors `IAgentEscrow.Escrow`). */
export interface SimEscrowRecord {
  id: bigint;
  payer: Address;
  payee: Address;
  token: Address;
  amount: bigint;
  expiresAt: bigint;
  createdAt: bigint;
  status: Status;
  arbiter: Address;
  validator: Address;
  validationRequestHash: Hex;
  validationThreshold: number;
  termsHash: Hex;
}

/** An ERC-8004 validation status (the simulator's stand-in for the Validation Registry). */
export interface ValidationStatus {
  validator: Address;
  response: number;
  lastUpdate: bigint;
}

/** `AgentEscrow` semantics (contracts/src/AgentEscrow.sol), including its revert reasons. */
export class SimEscrow {
  private readonly escrows: JMap<string, SimEscrowRecord>;
  private readonly counters: JMap<string, bigint>;
  /** ERC-8004 validation registry: requestHash → status. */
  readonly validations: JMap<string, ValidationStatus>;

  constructor(
    private readonly world: World,
    readonly address: Address,
  ) {
    this.escrows = new JMap(world.journal);
    this.counters = new JMap(world.journal);
    this.validations = new JMap(world.journal);
  }

  get(id: bigint): SimEscrowRecord | undefined {
    return this.escrows.get(id.toString());
  }

  count(): bigint {
    return this.counters.get("count") ?? 0n;
  }

  totalLocked(token: Address): bigint {
    return this.counters.get(key("locked", token)) ?? 0n;
  }

  private addLocked(token: Address, delta: bigint): void {
    this.counters.set(key("locked", token), this.totalLocked(token) + delta);
  }

  private save(e: SimEscrowRecord): void {
    this.escrows.set(e.id.toString(), e);
  }

  private pull(ctx: ExecContext, token: Address, from: Address, amount: bigint): void {
    this.world.call(
      ctx,
      this.address,
      token,
      0n,
      encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [from, this.address, amount] }),
    );
  }

  private pay(ctx: ExecContext, token: Address, to: Address, amount: bigint): void {
    this.world.call(
      ctx,
      this.address,
      token,
      0n,
      encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
    );
  }

  private existingOpen(id: bigint): SimEscrowRecord {
    const e = this.get(id);
    const status = e?.status ?? "None";
    if (!e || (status !== "Active" && status !== "Disputed")) revert(`InvalidStatus(${id}, ${status})`);
    return e;
  }

  lock(
    ctx: ExecContext,
    payer: Address,
    p: {
      token: Address;
      payee: Address;
      amount: bigint;
      expiresAt: bigint;
      arbiter: Address;
      validator: Address;
      validationRequestHash: Hex;
      validationThreshold: number;
      termsHash: Hex;
    },
  ): bigint {
    const now = BigInt(ctx.timestamp);
    check(p.token !== zeroAddress, "ZeroAddress()");
    if (p.payee === zeroAddress || p.payee === payer || p.payee === this.address)
      revert(`InvalidPayee(${p.payee})`);
    check(p.amount > 0n, "InvalidAmount()");
    if (p.expiresAt <= now || p.expiresAt > now + ESCROW_MAX_DURATION_SECONDS)
      revert(`InvalidExpiry(${p.expiresAt})`);
    if (
      p.arbiter !== zeroAddress &&
      (p.arbiter === payer || p.arbiter === p.payee || p.arbiter === this.address)
    ) {
      revert(`InvalidArbiter(${p.arbiter})`);
    }
    if (p.validator === zeroAddress) {
      check(p.validationRequestHash === zeroHash && p.validationThreshold === 0, "InvalidValidationConfig()");
    } else {
      if (p.validator === p.payee || p.validator === this.address) revert(`InvalidValidator(${p.validator})`);
      check(
        p.validationRequestHash !== zeroHash && p.validationThreshold > 0 && p.validationThreshold <= 100,
        "InvalidValidationConfig()",
      );
    }
    const id = this.count() + 1n;
    this.counters.set("count", id);
    this.save({
      id,
      payer: getAddress(payer),
      payee: getAddress(p.payee),
      token: getAddress(p.token),
      amount: p.amount,
      expiresAt: p.expiresAt,
      createdAt: now,
      status: "Active",
      arbiter: getAddress(p.arbiter),
      validator: getAddress(p.validator),
      validationRequestHash: p.validationRequestHash,
      validationThreshold: p.validationThreshold,
      termsHash: p.termsHash,
    });
    if (p.validator !== zeroAddress) {
      emitLog(ctx, this.address, VALIDATION_CONFIGURED, {
        id,
        validator: p.validator,
        requestHash: p.validationRequestHash,
        threshold: p.validationThreshold,
      });
    }
    this.addLocked(p.token, p.amount);
    emitLog(ctx, this.address, LOCKED, {
      id,
      payer,
      payee: p.payee,
      token: p.token,
      amount: p.amount,
      expiresAt: p.expiresAt,
      arbiter: p.arbiter,
      termsHash: p.termsHash,
    });
    this.pull(ctx, p.token, payer, p.amount);
    return id;
  }

  private doRelease(ctx: ExecContext, caller: Address, e: SimEscrowRecord, reason: number): void {
    this.save({ ...e, status: "Released" });
    this.addLocked(e.token, -e.amount);
    emitLog(ctx, this.address, RELEASED, {
      id: e.id,
      payee: e.payee,
      caller,
      token: e.token,
      amount: e.amount,
      reason,
    });
    this.pay(ctx, e.token, e.payee, e.amount);
  }

  release(ctx: ExecContext, caller: Address, id: bigint): void {
    const e = this.existingOpen(id);
    let reason: number;
    if (getAddress(caller) === e.payer) reason = 0;
    else if (getAddress(caller) === e.arbiter) reason = 1;
    else revert(`Unauthorized(${caller})`);
    this.doRelease(ctx, caller, e, reason);
  }

  /** Why `releaseByValidation` would fail now, or `null`. */
  validationFailure(ctx: Pick<ExecContext, "timestamp">, id: bigint): string | null {
    const e = this.get(id);
    const status = e?.status ?? "None";
    if (!e || status !== "Active") return `InvalidStatus(${id}, ${status})`;
    if (e.validator === zeroAddress) return `NoValidator(${id})`;
    if (BigInt(ctx.timestamp) >= e.expiresAt) return `EscrowExpired(${id}, ${e.expiresAt})`;
    const v = this.validations.get(e.validationRequestHash.toLowerCase());
    if (!v) return `ValidationNotFound(${id}, ${e.validationRequestHash})`;
    if (getAddress(v.validator) !== e.validator)
      return `ValidatorMismatch(${id}, ${e.validator}, ${v.validator})`;
    if (v.lastUpdate < e.createdAt) return `ValidationStale(${id}, ${v.lastUpdate}, ${e.createdAt})`;
    if (v.response < e.validationThreshold) {
      return `ValidationBelowThreshold(${id}, ${v.response}, ${e.validationThreshold})`;
    }
    return null;
  }

  releaseByValidation(ctx: ExecContext, caller: Address, id: bigint): void {
    const failure = this.validationFailure(ctx, id);
    if (failure) revert(failure);
    this.doRelease(ctx, caller, this.get(id) as SimEscrowRecord, 2);
  }

  refundableAt(e: SimEscrowRecord): bigint {
    return e.status === "Disputed" ? e.expiresAt + ESCROW_DISPUTE_TIMEOUT_SECONDS : e.expiresAt;
  }

  refund(ctx: ExecContext, caller: Address, id: bigint): void {
    const e = this.existingOpen(id);
    let reason: number;
    if (getAddress(caller) === e.payee) reason = 0;
    else {
      const availableAt = this.refundableAt(e);
      if (BigInt(ctx.timestamp) < availableAt) revert(`RefundNotYetAvailable(${id}, ${availableAt})`);
      reason = e.status === "Active" ? 1 : 2;
    }
    this.save({ ...e, status: "Refunded" });
    this.addLocked(e.token, -e.amount);
    emitLog(ctx, this.address, REFUNDED, {
      id,
      payer: e.payer,
      caller,
      token: e.token,
      amount: e.amount,
      reason,
    });
    this.pay(ctx, e.token, e.payer, e.amount);
  }

  dispute(ctx: ExecContext, caller: Address, id: bigint): void {
    const e = this.get(id);
    if (!e || e.status !== "Active") revert(`InvalidStatus(${id}, ${e?.status ?? "None"})`);
    const c = getAddress(caller);
    if (c !== e.payer && c !== e.payee) revert(`Unauthorized(${caller})`);
    if (e.arbiter === zeroAddress) revert(`NoArbiter(${id})`);
    if (BigInt(ctx.timestamp) >= e.expiresAt) revert(`EscrowExpired(${id}, ${e.expiresAt})`);
    this.save({ ...e, status: "Disputed" });
    emitLog(ctx, this.address, DISPUTED, {
      id,
      disputant: caller,
      refundableAt: e.expiresAt + ESCROW_DISPUTE_TIMEOUT_SECONDS,
    });
  }

  resolve(ctx: ExecContext, caller: Address, id: bigint, payeeAmount: bigint): void {
    const e = this.get(id);
    if (!e || e.status !== "Disputed") revert(`InvalidStatus(${id}, ${e?.status ?? "None"})`);
    if (getAddress(caller) !== e.arbiter) revert(`Unauthorized(${caller})`);
    if (payeeAmount > e.amount) revert(`InvalidResolution(${id}, ${payeeAmount}, ${e.amount})`);
    const payerAmount = e.amount - payeeAmount;
    this.save({ ...e, status: "Resolved" });
    this.addLocked(e.token, -e.amount);
    emitLog(ctx, this.address, RESOLVED, { id, arbiter: caller, token: e.token, payeeAmount, payerAmount });
    if (payeeAmount !== 0n) this.pay(ctx, e.token, e.payee, payeeAmount);
    if (payerAmount !== 0n) this.pay(ctx, e.token, e.payer, payerAmount);
  }

  handle(ctx: ExecContext, from: Address, data: Hex): Hex {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: agentEscrowAbi, data });
    } catch {
      revert("AgentEscrow: unsupported function");
    }
    const a = decoded.args as readonly unknown[];
    switch (decoded.functionName) {
      case "lock": {
        const id = this.lock(ctx, from, {
          token: getAddress(a[0] as Address),
          payee: getAddress(a[1] as Address),
          amount: a[2] as bigint,
          expiresAt: a[3] as bigint,
          arbiter: getAddress(a[4] as Address),
          validator: getAddress(a[5] as Address),
          validationRequestHash: a[6] as Hex,
          validationThreshold: Number(a[7]),
          termsHash: a[8] as Hex,
        });
        return encodeAbiParameters([{ type: "uint256" }], [id]);
      }
      case "release":
        this.release(ctx, from, a[0] as bigint);
        return "0x";
      case "releaseByValidation":
        this.releaseByValidation(ctx, from, a[0] as bigint);
        return "0x";
      case "refund":
        this.refund(ctx, from, a[0] as bigint);
        return "0x";
      case "dispute":
        this.dispute(ctx, from, a[0] as bigint);
        return "0x";
      case "resolve":
        this.resolve(ctx, from, a[0] as bigint, a[1] as bigint);
        return "0x";
      default:
        return revert(`AgentEscrow: ${decoded.functionName} is a view; read it from the gateway`);
    }
  }
}
