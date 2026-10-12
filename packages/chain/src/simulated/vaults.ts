import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  EARLY_WITHDRAWAL_TYPES,
  erc20Abi,
  TIME_LOCK_VAULTS_EIP712,
  timeLockVaultsAbi,
  VAULT_MAX_LOCK_SECONDS,
} from "../abis";
import { recoverStrict } from "./ecdsa";
import { JMap } from "./journal";
import { check, emitLog, eventOf, key, revert, type ExecContext } from "./vm";
import { isValidSignatureNow, type World } from "./world";

const CREATED = eventOf(timeLockVaultsAbi, "VaultCreated");
const DEPOSITED = eventOf(timeLockVaultsAbi, "Deposited");
const WITHDRAWN = eventOf(timeLockVaultsAbi, "Withdrawn");
const OWNER_CHANGED = eventOf(timeLockVaultsAbi, "OwnerChanged");

const SET_OWNER_TYPES = {
  SetOwner: [
    { name: "vaultId", type: "uint256" },
    { name: "newOwner", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** One vault (mirrors `ITimeLockVaults.Vault`). */
export interface SimVaultRecord {
  id: bigint;
  account: Address;
  unlockAt: bigint;
  owner: Address;
  nonce: bigint;
  token: Address;
  balance: bigint;
}

/** `TimeLockVaults` semantics (contracts/src/TimeLockVaults.sol). */
export class SimVaults {
  private readonly vaults: JMap<string, SimVaultRecord>;
  private readonly counters: JMap<string, bigint>;

  constructor(
    private readonly world: World,
    readonly address: Address,
  ) {
    this.vaults = new JMap(world.journal);
    this.counters = new JMap(world.journal);
  }

  get(id: bigint): SimVaultRecord | undefined {
    return this.vaults.get(id.toString());
  }

  count(): bigint {
    return this.counters.get("count") ?? 0n;
  }

  totalHeld(token: Address): bigint {
    return this.counters.get(key("held", token)) ?? 0n;
  }

  private existing(id: bigint): SimVaultRecord {
    const v = this.get(id);
    if (!v) revert(`VaultNotFound(${id})`);
    return v;
  }

  private domain() {
    return { ...TIME_LOCK_VAULTS_EIP712, chainId: this.world.chainId, verifyingContract: this.address };
  }

  /** EIP-712 digest the owner signs for an early withdrawal. */
  earlyWithdrawalDigest(id: bigint, amount: bigint, nonce: bigint, deadline: bigint): Hex {
    return hashTypedData({
      domain: this.domain(),
      types: EARLY_WITHDRAWAL_TYPES,
      primaryType: "EarlyWithdrawal",
      message: { vaultId: id, amount, nonce, deadline },
    });
  }

  createVault(ctx: ExecContext, account: Address, token: Address, unlockAt: bigint, owner: Address): bigint {
    check(token !== zeroAddress, "ZeroAddress()");
    if (
      owner === zeroAddress ||
      getAddress(owner) === getAddress(account) ||
      getAddress(owner) === this.address
    ) {
      revert(`InvalidOwner(${owner})`);
    }
    const now = BigInt(ctx.timestamp);
    if (unlockAt <= now || unlockAt > now + VAULT_MAX_LOCK_SECONDS) revert(`InvalidUnlockTime(${unlockAt})`);
    const id = this.count() + 1n;
    this.counters.set("count", id);
    this.vaults.set(id.toString(), {
      id,
      account: getAddress(account),
      unlockAt,
      owner: getAddress(owner),
      nonce: 0n,
      token: getAddress(token),
      balance: 0n,
    });
    emitLog(ctx, this.address, CREATED, { id, account, owner, token, unlockAt });
    return id;
  }

  deposit(ctx: ExecContext, from: Address, id: bigint, amount: bigint): void {
    const v = this.existing(id);
    check(amount !== 0n, "InvalidAmount()");
    const newBalance = v.balance + amount;
    this.vaults.set(id.toString(), { ...v, balance: newBalance });
    this.counters.set(key("held", v.token), this.totalHeld(v.token) + amount);
    emitLog(ctx, this.address, DEPOSITED, { id, from, amount, newBalance });
    this.world.call(
      ctx,
      this.address,
      v.token,
      0n,
      encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [from, this.address, amount] }),
    );
  }

  private doWithdraw(
    ctx: ExecContext,
    caller: Address,
    v: SimVaultRecord,
    amount: bigint,
    early: boolean,
  ): void {
    check(amount !== 0n, "InvalidAmount()");
    if (amount > v.balance) revert(`InsufficientVaultBalance(${v.id}, ${amount}, ${v.balance})`);
    this.vaults.set(v.id.toString(), { ...v, balance: v.balance - amount });
    this.counters.set(key("held", v.token), this.totalHeld(v.token) - amount);
    emitLog(ctx, this.address, WITHDRAWN, { id: v.id, account: v.account, caller, amount, early });
    this.world.call(
      ctx,
      this.address,
      v.token,
      0n,
      encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [v.account, amount] }),
    );
  }

  withdraw(ctx: ExecContext, caller: Address, id: bigint, amount: bigint): void {
    const v = this.existing(id);
    if (BigInt(ctx.timestamp) < v.unlockAt) revert(`StillLocked(${id}, ${v.unlockAt})`);
    this.doWithdraw(ctx, caller, v, amount, false);
  }

  private useOwnerSignature(
    ctx: ExecContext,
    v: SimVaultRecord,
    digest: Hex,
    deadline: bigint,
    signature: Hex,
  ): SimVaultRecord {
    if (BigInt(ctx.timestamp) > deadline) revert(`SignatureExpired(${deadline})`);
    check(isValidSignatureNow(this.world, v.owner, digest, signature, recoverStrict), "InvalidSignature()");
    const updated = { ...v, nonce: v.nonce + 1n };
    this.vaults.set(v.id.toString(), updated);
    return updated;
  }

  withdrawWithSignature(
    ctx: ExecContext,
    caller: Address,
    id: bigint,
    amount: bigint,
    deadline: bigint,
    signature: Hex,
  ): void {
    const v = this.existing(id);
    const digest = this.earlyWithdrawalDigest(id, amount, v.nonce, deadline);
    const updated = this.useOwnerSignature(ctx, v, digest, deadline, signature);
    this.doWithdraw(ctx, caller, updated, amount, true);
  }

  setOwner(ctx: ExecContext, id: bigint, newOwner: Address, deadline: bigint, signature: Hex): void {
    const v = this.existing(id);
    if (
      newOwner === zeroAddress ||
      getAddress(newOwner) === v.account ||
      getAddress(newOwner) === this.address
    ) {
      revert(`InvalidOwner(${newOwner})`);
    }
    const digest = hashTypedData({
      domain: this.domain(),
      types: SET_OWNER_TYPES,
      primaryType: "SetOwner",
      message: { vaultId: id, newOwner, nonce: v.nonce, deadline },
    });
    const updated = this.useOwnerSignature(ctx, v, digest, deadline, signature);
    this.vaults.set(id.toString(), { ...updated, owner: getAddress(newOwner) });
    emitLog(ctx, this.address, OWNER_CHANGED, { id, previousOwner: v.owner, newOwner });
  }

  handle(ctx: ExecContext, from: Address, data: Hex): Hex {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: timeLockVaultsAbi, data });
    } catch {
      revert("TimeLockVaults: unsupported function");
    }
    const a = decoded.args as readonly unknown[];
    switch (decoded.functionName) {
      case "createVault": {
        const id = this.createVault(
          ctx,
          from,
          getAddress(a[0] as Address),
          a[1] as bigint,
          getAddress(a[2] as Address),
        );
        return encodeAbiParameters([{ type: "uint256" }], [id]);
      }
      case "deposit":
        this.deposit(ctx, from, a[0] as bigint, a[1] as bigint);
        return "0x";
      case "withdraw":
        this.withdraw(ctx, from, a[0] as bigint, a[1] as bigint);
        return "0x";
      case "withdrawWithSignature":
        this.withdrawWithSignature(ctx, from, a[0] as bigint, a[1] as bigint, a[2] as bigint, a[3] as Hex);
        return "0x";
      case "setOwner":
        this.setOwner(ctx, a[0] as bigint, getAddress(a[1] as Address), a[2] as bigint, a[3] as Hex);
        return "0x";
      default:
        return revert(`TimeLockVaults: ${decoded.functionName} is a view; read it from the gateway`);
    }
  }
}
