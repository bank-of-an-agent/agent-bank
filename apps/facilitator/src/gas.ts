import type { Address } from "viem";

/**
 * Relayer gas guard. The relayer pays gas for every `transferWithAuthorization`; with too little
 * ETH the transaction cannot be sent (or worse, hangs), so the facilitator refuses to settle
 * (`facilitator_unavailable`, fail closed) while the balance is below `RELAYER_MIN_BALANCE_WEI`.
 * The balance is read at most once per `cacheMs` (default 30 s); concurrent callers share one
 * lookup, and a failed lookup is never cached.
 */

export interface RelayerGasGuardOptions {
  address: Address;
  /** Refuse to settle below this many wei (0: never refuse, only report). */
  minBalanceWei: bigint;
  /** Native balance of the relayer, in wei. */
  balanceOf: () => Promise<bigint>;
  /** How long a reading is reused. Default 30 s. */
  cacheMs?: number;
  /** Wall clock in ms (tests). */
  now?: () => number;
}

export interface RelayerGasCheck {
  ok: boolean;
  balanceWei: bigint;
}

export class RelayerGasGuard {
  readonly address: Address;
  readonly minBalanceWei: bigint;
  readonly #balanceOf: () => Promise<bigint>;
  readonly #cacheMs: number;
  readonly #now: () => number;
  #cached: { balanceWei: bigint; at: number } | undefined;
  #pending: Promise<bigint> | undefined;

  constructor(options: RelayerGasGuardOptions) {
    if (options.minBalanceWei < 0n) throw new RangeError("minBalanceWei must be >= 0");
    this.address = options.address;
    this.minBalanceWei = options.minBalanceWei;
    this.#balanceOf = options.balanceOf;
    this.#cacheMs = options.cacheMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  /** The relayer's balance, at most `cacheMs` old. Throws when the chain cannot answer. */
  async balance(): Promise<bigint> {
    const cached = this.#cached;
    if (cached && this.#now() - cached.at < this.#cacheMs) return cached.balanceWei;
    this.#pending ??= this.#balanceOf().then(
      (balanceWei) => {
        this.#cached = { balanceWei, at: this.#now() };
        this.#pending = undefined;
        return balanceWei;
      },
      (error: unknown) => {
        this.#pending = undefined;
        throw error;
      },
    );
    return this.#pending;
  }

  /** Whether the relayer can pay for a settlement. Throws when the balance cannot be read. */
  async check(): Promise<RelayerGasCheck> {
    const balanceWei = await this.balance();
    return { ok: balanceWei >= this.minBalanceWei, balanceWei };
  }
}
