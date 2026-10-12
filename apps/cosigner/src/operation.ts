import type { ChainGateway, DecodedCall } from "@agentbank/chain";
import type { COSIGN_ACTIONS, PaymentKind } from "@agentbank/core";
import type { Address } from "viem";

/**
 * What the co-signer needs from a chain gateway: the contracts it targets and
 * the two pure functions that re-derive an operation from its raw bytes.
 */
export type OperationCodec = Pick<
  ChainGateway,
  "chainId" | "contracts" | "decodeOperation" | "hashOperation"
>;

export type CosignAction = (typeof COSIGN_ACTIONS)[number];

/** Payment kinds each action may be stated with. */
const ACTION_KINDS: Readonly<Record<CosignAction, readonly PaymentKind[]>> = {
  transfer: ["transfer", "payout", "refill"],
  "escrow.lock": ["escrow"],
  "escrow.release": ["escrow"],
  "escrow.refund": ["escrow"],
  "escrow.dispute": ["escrow"],
  "stream.create": ["stream"],
  "stream.cancel": ["stream"],
  "stream.top_up": ["stream"],
};

/** Actions after an escrow lock or stream creation that move nothing out of the account. */
const NO_OUTFLOW: Readonly<
  Partial<Record<CosignAction, { kind: DecodedCall["kind"]; contract: "escrow" | "streams" }>>
> = {
  "escrow.release": { kind: "escrow_release", contract: "escrow" },
  "escrow.refund": { kind: "escrow_refund", contract: "escrow" },
  "escrow.dispute": { kind: "escrow_dispute", contract: "escrow" },
  "stream.cancel": { kind: "stream_cancel", contract: "streams" },
};

/** The action a cosign request stands for: stated, or derived from the payment kind. */
export function actionFor(kind: PaymentKind, stated: CosignAction | undefined): CosignAction | null {
  if (stated !== undefined) return ACTION_KINDS[stated].includes(kind) ? stated : null;
  if (kind === "escrow") return "escrow.lock";
  if (kind === "stream") return "stream.create";
  if (kind === "x402") return null;
  return "transfer";
}

/** Whether an action moves nothing out of the account (beyond attached fees and sweeps). */
export function movesNothing(action: CosignAction): boolean {
  return NO_OUTFLOW[action] !== undefined;
}

/** The intent the API states for an operation (amounts in minor units, addresses lowercase). */
export interface StatedIntent {
  action: CosignAction;
  kind: PaymentKind;
  amount: bigint;
  fee: bigint;
  /** The payee address the API claims; must equal the decoded recipient when the calldata shows one. */
  counterpartyAddress: string | null;
  /** The escrow/streams contract the API claims (optional); must equal the decoded one. */
  contract?: string | null | undefined;
  /** On-chain escrow or stream id, for actions on an existing escrow or stream. */
  onchainId?: bigint | null | undefined;
  /** Savings sweep to the org treasury the operation carries (0 = none). */
  savingsSweep?: bigint | undefined;
}

export interface MatchRules {
  usdc: Address;
  revenue: Address;
  escrow?: Address | undefined;
  streams?: Address | undefined;
  vaults?: Address | undefined;
  /** The org's registered treasury (`setTreasury`), or `null` when none is registered. */
  treasury?: string | null | undefined;
  /** Largest fee sweep (accrued fees, beyond the stated fee) allowed in one operation. */
  maxFeeSweep: bigint;
}

/** What the operation provably does, decoded from its calldata. */
export interface VerifiedSpend {
  action: CosignAction;
  /** The payment counted against policy caps (0 for actions that move nothing out). */
  amount: bigint;
  /**
   * Lowercase address that receives the payment when the calldata shows it
   * (transfer recipient, escrow or stream payee); `null` for a stream top-up
   * (the stream's payee was fixed at creation) and for no-outflow actions.
   */
  recipient: string | null;
  /** Lowercase Agent Bank contract the operation goes through (escrow, streams), if any. */
  contract: string | null;
  /** Everything paid to the revenue address: the fee plus any fee sweep. */
  revenue: bigint;
  /** The savings sweep to the org treasury (not policy spend). */
  savings: bigint;
  /** Everything the operation moves out of the account. */
  outflow: bigint;
}

export type MatchResult =
  | { ok: true; spend: VerifiedSpend }
  | {
      ok: false;
      reason: string;
      rule: "cosigner.intent_mismatch" | "cosigner.vault_owner_only" | "cosigner.treasury";
    };

/** The most calls a co-signed operation may carry: payment (≤ 2 calls) + fee + fee sweep + savings sweep. */
const MAX_CALLS = 5;
const UINT = /^(0|[1-9][0-9]*)$/;

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function amountOf(call: DecodedCall): bigint | null {
  return typeof call.amount === "string" && UINT.test(call.amount) ? BigInt(call.amount) : null;
}

function idArg(call: DecodedCall, name: "escrowId" | "streamId"): bigint | null {
  const value = call.args?.[name];
  return typeof value === "string" && UINT.test(value) ? BigInt(value) : null;
}

function describe(call: DecodedCall, index: number): string {
  return `call ${index} (${call.kind} on ${call.to})`;
}

function isUsdcTransferTo(call: DecodedCall, usdc: string, to: string | null | undefined): boolean {
  return (
    call.kind === "erc20_transfer" &&
    same(call.to, usdc) &&
    same(call.token, usdc) &&
    same(call.recipient, to)
  );
}

type Indexed = { call: DecodedCall; index: number };

/**
 * Require that the decoded calls do exactly what the stated action says and
 * nothing else (conventions: `COSIGN_ACTIONS` in core/cosigner-api.ts):
 * - `transfer`: exactly one USDC transfer of the stated amount to the stated payee;
 * - `escrow.lock` / `stream.create`: a USDC approval of the contract immediately
 *   followed by its lock/create for the same amount and payee;
 * - `stream.top_up`: a USDC approval of the streams contract immediately followed
 *   by `topUp(onchain_id, amount)` (the contract only lets the payer top up);
 * - `escrow.release` / `escrow.refund` / `escrow.dispute` / `stream.cancel`:
 *   exactly one such call on the configured contract for `onchain_id`, and no
 *   outflow (`intent.amount` = 0); the contracts enforce caller and destinations.
 * Any action may also carry up to two USDC transfers to the revenue address
 * (the stated fee and a fee sweep bounded by `maxFeeSweep`) and one transfer of
 * exactly `savings_sweep` to the org's registered treasury. Native value,
 * unknown calls, other approvals, `transferFrom`, module and session calls,
 * vault calls (owner operations only) and any mismatch are refused.
 */
export function matchCalls(
  calls: readonly DecodedCall[],
  intent: StatedIntent,
  rules: MatchRules,
): MatchResult {
  const fail = (
    reason: string,
    rule: "cosigner.intent_mismatch" | "cosigner.treasury" = "cosigner.intent_mismatch",
  ): MatchResult => ({
    ok: false,
    reason,
    rule,
  });
  if (calls.length === 0) return fail("the operation executes no calls");
  if (calls.length > MAX_CALLS)
    return fail(`the operation executes ${calls.length} calls; at most ${MAX_CALLS} are expected`);
  if (intent.counterpartyAddress !== null && same(intent.counterpartyAddress, rules.revenue)) {
    return fail("the payee is the Agent Bank revenue address");
  }

  let remaining: Indexed[] = [];
  for (const [index, call] of calls.entries()) {
    if (call.value !== "0") return fail(`${describe(call, index)} sends native value`);
    if (call.kind === "unknown") return fail(`${describe(call, index)} is not a recognised call`);
    const touchesVaults =
      call.kind.startsWith("vault_") ||
      same(call.to, rules.vaults) ||
      (call.kind === "erc20_approve" && same(call.spender, rules.vaults));
    if (touchesVaults) {
      return {
        ok: false,
        rule: "cosigner.vault_owner_only",
        reason: `${describe(call, index)} touches the time-locked vaults; vault deposits and withdrawals are owner operations, never session operations`,
      };
    }
    remaining.push({ call, index });
  }

  // Savings sweep: exactly one transfer of the stated amount to the org's registered treasury.
  const savings = intent.savingsSweep ?? 0n;
  if (savings > 0n) {
    if (!rules.treasury)
      return fail(
        "the operation carries a savings sweep but the org has no registered treasury",
        "cosigner.treasury",
      );
    const sweep = remaining.find(
      (c) => isUsdcTransferTo(c.call, rules.usdc, rules.treasury) && amountOf(c.call) === savings,
    );
    if (!sweep) {
      return fail(
        `the operation carries no transfer of the stated savings sweep (${savings}) to the org treasury ${rules.treasury}`,
        "cosigner.treasury",
      );
    }
    remaining = remaining.filter((c) => c !== sweep);
  }

  // Fees: at most two USDC transfers to the revenue address, between the fee and the fee plus the sweep cap.
  let revenueCalls = 0;
  let revenue = 0n;
  const primary: Indexed[] = [];
  for (const c of remaining) {
    if (isUsdcTransferTo(c.call, rules.usdc, rules.revenue)) {
      const amount = amountOf(c.call);
      if (amount === null) return fail(`${describe(c.call, c.index)} has no amount`);
      revenueCalls += 1;
      revenue += amount;
      continue;
    }
    primary.push(c);
  }
  if (revenueCalls > 2)
    return fail(
      `the operation makes ${revenueCalls} transfers to the revenue address; at most 2 (fee and fee sweep)`,
    );
  if (revenue < intent.fee)
    return fail(
      `the operation pays ${revenue} to the revenue address, less than the stated fee of ${intent.fee}`,
    );
  if (revenue - intent.fee > rules.maxFeeSweep) {
    return fail(`the fee sweep of ${revenue - intent.fee} exceeds the maximum of ${rules.maxFeeSweep}`);
  }

  const payee = intent.counterpartyAddress;
  const done = (amount: bigint, recipient: string | null, contract: string | null): MatchResult => ({
    ok: true,
    spend: {
      action: intent.action,
      amount,
      recipient: recipient === null ? null : recipient.toLowerCase(),
      contract,
      revenue,
      savings,
      outflow: amount + revenue + savings,
    },
  });

  if (!ACTION_KINDS[intent.action].includes(intent.kind)) {
    return fail(`action ${intent.action} does not fit payment kind ${intent.kind}`);
  }
  const noOutflow = NO_OUTFLOW[intent.action];
  if (noOutflow) {
    const contract = noOutflow.contract === "escrow" ? rules.escrow : rules.streams;
    if (!contract) return fail(`no ${noOutflow.contract} contract is configured on this chain`);
    if (intent.amount !== 0n)
      return fail(`${intent.action} moves no funds out of the account; the intent amount must be 0`);
    if (intent.contract && !same(intent.contract, contract)) {
      return fail(
        `the intent names contract ${intent.contract}, but ${intent.action} goes through ${contract}`,
      );
    }
    if (intent.onchainId === null || intent.onchainId === undefined)
      return fail(`${intent.action} needs the on-chain id (onchain_id)`);
    if (primary.length !== 1)
      return fail(
        `${intent.action} must be exactly one call besides fees and sweeps; found ${primary.length}`,
      );
    const { call, index } = primary[0] as Indexed;
    if (call.kind !== noOutflow.kind || !same(call.to, contract)) {
      return fail(
        `${describe(call, index)} is not a ${noOutflow.kind} on the configured ${noOutflow.contract} contract`,
      );
    }
    const id = idArg(call, noOutflow.contract === "escrow" ? "escrowId" : "streamId");
    if (id !== intent.onchainId)
      return fail(`${describe(call, index)} acts on id ${id}, not the stated ${intent.onchainId}`);
    return done(0n, null, contract.toLowerCase());
  }

  if (intent.amount <= 0n) return fail(`${intent.action} must move a positive amount`);
  switch (intent.action) {
    case "transfer": {
      if (intent.contract)
        return fail(`a ${intent.kind} goes through no contract, but the intent names ${intent.contract}`);
      if (primary.length !== 1) {
        return fail(
          `a ${intent.kind} must be exactly one USDC transfer besides fees and sweeps; found ${primary.length} other calls`,
        );
      }
      const { call, index } = primary[0] as Indexed;
      if (call.kind !== "erc20_transfer") return fail(`${describe(call, index)} is not a USDC transfer`);
      if (!same(call.to, rules.usdc) || !same(call.token, rules.usdc))
        return fail(`${describe(call, index)} moves a token other than USDC`);
      if (payee === null) return fail("the intent names no payee address");
      if (!same(call.recipient, payee))
        return fail(`${describe(call, index)} pays ${call.recipient}, not the stated payee ${payee}`);
      if (amountOf(call) !== intent.amount) {
        return fail(`${describe(call, index)} moves ${call.amount}, not the stated amount ${intent.amount}`);
      }
      return done(intent.amount, payee, null);
    }
    case "escrow.lock":
    case "stream.create":
    case "stream.top_up": {
      const onEscrow = intent.action === "escrow.lock";
      const label = onEscrow ? "escrow" : "streams";
      const contract = onEscrow ? rules.escrow : rules.streams;
      const createKind =
        intent.action === "escrow.lock"
          ? "escrow_lock"
          : intent.action === "stream.create"
            ? "stream_create"
            : "stream_topup";
      if (!contract) return fail(`no ${label} contract is configured on this chain`);
      if (intent.contract && !same(intent.contract, contract)) {
        return fail(
          `the intent names contract ${intent.contract}, but ${intent.action} goes through ${contract}`,
        );
      }
      if (primary.length !== 2) {
        return fail(
          `${intent.action} must be a USDC approval and a ${createKind} besides fees and sweeps; found ${primary.length} other calls`,
        );
      }
      const [approve, create] = primary as [Indexed, Indexed];
      if (
        approve.call.kind !== "erc20_approve" ||
        !same(approve.call.to, rules.usdc) ||
        !same(approve.call.token, rules.usdc)
      ) {
        return fail(`${describe(approve.call, approve.index)} is not a USDC approval`);
      }
      if (!same(approve.call.spender, contract)) {
        return fail(
          `${describe(approve.call, approve.index)} approves ${approve.call.spender}, not the ${label} contract`,
        );
      }
      if (amountOf(approve.call) !== intent.amount) {
        return fail(
          `${describe(approve.call, approve.index)} approves ${approve.call.amount}, not the stated amount ${intent.amount}`,
        );
      }
      if (create.call.kind !== createKind || !same(create.call.to, contract)) {
        return fail(
          `${describe(create.call, create.index)} is not a ${createKind} on the configured ${label} contract`,
        );
      }
      if (create.index !== approve.index + 1) {
        return fail(`the approval (call ${approve.index}) must be immediately followed by the ${createKind}`);
      }
      if (amountOf(create.call) !== intent.amount) {
        return fail(
          `${describe(create.call, create.index)} moves ${create.call.amount}, not the stated amount ${intent.amount}`,
        );
      }
      if (intent.action === "stream.top_up") {
        if (intent.onchainId === null || intent.onchainId === undefined)
          return fail("stream.top_up needs the stream id (onchain_id)");
        const id = idArg(create.call, "streamId");
        if (id !== intent.onchainId)
          return fail(
            `${describe(create.call, create.index)} tops up stream ${id}, not the stated ${intent.onchainId}`,
          );
        return done(intent.amount, null, contract.toLowerCase());
      }
      if (!same(create.call.token, rules.usdc))
        return fail(`${describe(create.call, create.index)} locks a token other than USDC`);
      if (payee === null) return fail("the intent names no payee address");
      if (!same(create.call.recipient, payee)) {
        return fail(
          `${describe(create.call, create.index)} pays ${create.call.recipient}, not the stated payee ${payee}`,
        );
      }
      return done(intent.amount, payee, contract.toLowerCase());
    }
    default:
      return fail(`action ${intent.action} cannot be co-signed`);
  }
}
