import {
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  maxUint256,
  size,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  CANCEL_AUTHORIZATION_TYPES,
  erc20Abi,
  PERMIT_TYPES,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from "../abis";
import { JMap } from "./journal";
import { ecrecover, packSignature, splitSignature } from "./ecdsa";
import { check, emitLog, eventOf, key, revert, type ExecContext } from "./vm";
import type { World } from "./world";

const TRANSFER = eventOf(erc20Abi, "Transfer");
const APPROVAL = eventOf(erc20Abi, "Approval");
const AUTHORIZATION_USED = eventOf(erc20Abi, "AuthorizationUsed");
const AUTHORIZATION_CANCELED = eventOf(erc20Abi, "AuthorizationCanceled");

const TRUE = encodeAbiParameters([{ type: "bool" }], [true]);
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * USDC as FiatToken v2.2 behaves for Agent Bank: ERC-20 with FiatToken revert strings, EIP-3009
 * (`transferWithAuthorization` and `receiveWithAuthorization` in both overloads,
 * `cancelAuthorization`, `authorizationState`), EIP-2612 `permit` (both overloads), `increaseAllowance` /
 * `decreaseAllowance`, and ERC-1271 signatures for contract signers. No pause, blacklist or minter
 * roles; {@link SimToken.mint} is the faucet.
 */
export class SimToken {
  private readonly balances: JMap<string, bigint>;
  private readonly allowances: JMap<string, bigint>;
  private readonly supply: JMap<string, bigint>;
  private readonly authorizations: JMap<string, true>;
  private readonly permitNonces: JMap<string, bigint>;
  /** Holders whose balance changed since the last {@link takeDirty}. */
  private dirty = new Set<Address>();

  constructor(
    private readonly world: World,
    readonly address: Address,
    readonly name = "USDC",
    readonly version = "2",
  ) {
    const j = world.journal;
    this.balances = new JMap(j);
    this.allowances = new JMap(j);
    this.supply = new JMap(j);
    this.authorizations = new JMap(j);
    this.permitNonces = new JMap(j);
  }

  balanceOf(holder: Address): bigint {
    return this.balances.get(key(holder)) ?? 0n;
  }

  allowance(owner: Address, spender: Address): bigint {
    return this.allowances.get(key(owner, spender)) ?? 0n;
  }

  totalSupply(): bigint {
    return this.supply.get("supply") ?? 0n;
  }

  authorizationState(authorizer: Address, nonce: Hex): boolean {
    return this.authorizations.has(key(authorizer, nonce));
  }

  nonces(owner: Address): bigint {
    return this.permitNonces.get(key(owner)) ?? 0n;
  }

  /** Holders whose balance changed since the previous call. */
  takeDirty(): Address[] {
    const out = [...this.dirty];
    this.dirty = new Set();
    return out;
  }

  private setBalance(holder: Address, value: bigint): void {
    this.balances.set(key(holder), value);
    this.dirty.add(getAddress(holder));
  }

  /** Faucet: mint `amount` to `to` (emits `Transfer(0x0, to, amount)`). */
  mint(ctx: ExecContext, to: Address, amount: bigint): void {
    check(to !== zeroAddress, "FiatToken: mint to the zero address");
    check(amount > 0n, "FiatToken: mint amount not greater than 0");
    this.supply.set("supply", this.totalSupply() + amount);
    this.setBalance(to, this.balanceOf(to) + amount);
    emitLog(ctx, this.address, TRANSFER, { from: zeroAddress, to, value: amount });
  }

  transfer(ctx: ExecContext, from: Address, to: Address, value: bigint): void {
    check(from !== zeroAddress, "ERC20: transfer from the zero address");
    check(to !== zeroAddress, "ERC20: transfer to the zero address");
    const balance = this.balanceOf(from);
    check(value <= balance, "ERC20: transfer amount exceeds balance");
    this.setBalance(from, balance - value);
    this.setBalance(to, this.balanceOf(to) + value);
    emitLog(ctx, this.address, TRANSFER, { from, to, value });
  }

  approve(ctx: ExecContext, owner: Address, spender: Address, value: bigint): void {
    check(owner !== zeroAddress, "ERC20: approve from the zero address");
    check(spender !== zeroAddress, "ERC20: approve to the zero address");
    this.allowances.set(key(owner, spender), value);
    emitLog(ctx, this.address, APPROVAL, { owner, spender, value });
  }

  transferFrom(ctx: ExecContext, spender: Address, from: Address, to: Address, value: bigint): void {
    const allowed = this.allowance(from, spender);
    check(value <= allowed, "ERC20: transfer amount exceeds allowance");
    this.transfer(ctx, from, to, value);
    this.allowances.set(key(from, spender), allowed - value);
  }

  private domain() {
    return {
      name: this.name,
      version: this.version,
      chainId: this.world.chainId,
      verifyingContract: this.address,
    };
  }

  /** FiatToken `SignatureChecker`: ERC-1271 for contracts, `ECRecover.recover` (reverting) for EOAs. */
  private requireValidSignature(signer: Address, digest: Hex, signature: Hex, failure: string): void {
    if (this.world.hasCode(signer)) {
      check(this.world.isValidSignature1271(signer, digest, signature), failure);
      return;
    }
    check(size(signature) === 65, "ECRecover: invalid signature length");
    const parts = splitSignature(signature);
    check(parts !== null && parts.s <= HALF_N, "ECRecover: invalid signature 's' value");
    check(parts.v === 27 || parts.v === 28, "ECRecover: invalid signature 'v' value");
    const recovered = ecrecover(digest, parts.v, parts.r, parts.s);
    check(recovered !== null, "ECRecover: invalid signature");
    check(recovered === getAddress(signer), failure);
  }

  private requireValidAuthorization(
    ctx: ExecContext,
    authorizer: Address,
    nonce: Hex,
    validAfter: bigint,
    validBefore: bigint,
  ): void {
    check(BigInt(ctx.timestamp) > validAfter, "FiatTokenV2: authorization is not yet valid");
    check(BigInt(ctx.timestamp) < validBefore, "FiatTokenV2: authorization is expired");
    check(!this.authorizationState(authorizer, nonce), "FiatTokenV2: authorization is used or canceled");
  }

  private useAuthorization(ctx: ExecContext, authorizer: Address, nonce: Hex): void {
    this.authorizations.set(key(authorizer, nonce), true);
    emitLog(ctx, this.address, AUTHORIZATION_USED, { authorizer, nonce });
  }

  /** EIP-3009 `transferWithAuthorization` / `receiveWithAuthorization`. */
  transferWithAuthorization(
    ctx: ExecContext,
    caller: Address,
    a: { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex },
    signature: Hex,
    receive = false,
  ): void {
    if (receive) check(getAddress(caller) === getAddress(a.to), "FiatTokenV2: caller must be the payee");
    this.requireValidAuthorization(ctx, a.from, a.nonce, a.validAfter, a.validBefore);
    const digest = receive
      ? hashTypedData({
          domain: this.domain(),
          types: RECEIVE_WITH_AUTHORIZATION_TYPES,
          primaryType: "ReceiveWithAuthorization",
          message: a,
        })
      : hashTypedData({
          domain: this.domain(),
          types: TRANSFER_WITH_AUTHORIZATION_TYPES,
          primaryType: "TransferWithAuthorization",
          message: a,
        });
    this.requireValidSignature(a.from, digest, signature, "FiatTokenV2: invalid signature");
    this.useAuthorization(ctx, a.from, a.nonce);
    this.transfer(ctx, a.from, a.to, a.value);
  }

  cancelAuthorization(ctx: ExecContext, authorizer: Address, nonce: Hex, signature: Hex): void {
    check(!this.authorizationState(authorizer, nonce), "FiatTokenV2: authorization is used or canceled");
    const digest = hashTypedData({
      domain: this.domain(),
      types: CANCEL_AUTHORIZATION_TYPES,
      primaryType: "CancelAuthorization",
      message: { authorizer, nonce },
    });
    this.requireValidSignature(authorizer, digest, signature, "FiatTokenV2: invalid signature");
    this.authorizations.set(key(authorizer, nonce), true);
    emitLog(ctx, this.address, AUTHORIZATION_CANCELED, { authorizer, nonce });
  }

  permit(
    ctx: ExecContext,
    owner: Address,
    spender: Address,
    value: bigint,
    deadline: bigint,
    signature: Hex,
  ): void {
    check(deadline === maxUint256 || deadline >= BigInt(ctx.timestamp), "FiatTokenV2: permit is expired");
    const nonce = this.nonces(owner);
    const digest = hashTypedData({
      domain: this.domain(),
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message: { owner, spender, value, nonce, deadline },
    });
    this.requireValidSignature(owner, digest, signature, "EIP2612: invalid signature");
    this.permitNonces.set(key(owner), nonce + 1n);
    this.approve(ctx, owner, spender, value);
  }

  /** Dispatch an ABI-encoded call from `from`. */
  handle(ctx: ExecContext, from: Address, data: Hex): Hex {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: erc20Abi, data });
    } catch {
      revert("USDC: unsupported function");
    }
    const a = decoded.args as readonly unknown[];
    switch (decoded.functionName) {
      case "transfer":
        this.transfer(ctx, from, a[0] as Address, a[1] as bigint);
        return TRUE;
      case "approve":
        this.approve(ctx, from, a[0] as Address, a[1] as bigint);
        return TRUE;
      case "transferFrom":
        this.transferFrom(ctx, from, a[0] as Address, a[1] as Address, a[2] as bigint);
        return TRUE;
      case "increaseAllowance":
        this.approve(ctx, from, a[0] as Address, this.allowance(from, a[0] as Address) + (a[1] as bigint));
        return TRUE;
      case "decreaseAllowance": {
        const current = this.allowance(from, a[0] as Address);
        check((a[1] as bigint) <= current, "ERC20: decreased allowance below zero");
        this.approve(ctx, from, a[0] as Address, current - (a[1] as bigint));
        return TRUE;
      }
      case "transferWithAuthorization":
      case "receiveWithAuthorization": {
        const signature =
          a.length === 9 ? packSignature(a[7] as Hex, a[8] as Hex, Number(a[6])) : (a[6] as Hex);
        this.transferWithAuthorization(
          ctx,
          from,
          {
            from: a[0] as Address,
            to: a[1] as Address,
            value: a[2] as bigint,
            validAfter: a[3] as bigint,
            validBefore: a[4] as bigint,
            nonce: a[5] as Hex,
          },
          signature,
          decoded.functionName === "receiveWithAuthorization",
        );
        return "0x";
      }
      case "cancelAuthorization": {
        const signature =
          a.length === 5 ? packSignature(a[3] as Hex, a[4] as Hex, Number(a[2])) : (a[2] as Hex);
        this.cancelAuthorization(ctx, a[0] as Address, a[1] as Hex, signature);
        return "0x";
      }
      case "permit":
        this.permit(
          ctx,
          a[0] as Address,
          a[1] as Address,
          a[2] as bigint,
          a[3] as bigint,
          a.length === 7 ? packSignature(a[5] as Hex, a[6] as Hex, Number(a[4])) : (a[4] as Hex),
        );
        return "0x";
      case "balanceOf":
        return encodeAbiParameters([{ type: "uint256" }], [this.balanceOf(a[0] as Address)]);
      default:
        return revert(`USDC: ${decoded.functionName} is not supported by the simulator`);
    }
  }
}
