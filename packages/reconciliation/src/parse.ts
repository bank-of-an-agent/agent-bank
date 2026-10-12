import { AgentBankError, canonicalSha256, type ChainEventInternal } from "@agentbank/core";
import { getAddress, isAddress, sha256, stringToBytes } from "viem";

/**
 * Normalization of the events the indexer pushes: hashes lowercase, addresses checksummed,
 * amounts bigint, grouped per transaction in canonical order. Pure functions only.
 */

/** An event as the reconciler works with it. */
export interface ChainEvent {
  /** The id exactly as the indexer sent it (echoed back in results). */
  sentId: string;
  /** Lowercase deterministic id `${chainId}:${blockHash}:${txHash}:${logIndex}`. */
  id: string;
  /** The same identity in the ledger's id format (`cev_…`), see {@link ledgerRefOf}. */
  ledgerRef: string;
  logIndex: number;
  /** Lowercase emitting contract. */
  contract: string;
  name: string;
  args: Record<string, string>;
  userOpHash: string | null;
  raw: ChainEventInternal;
}

/** One transaction of one block: the unit the reconciler processes atomically. */
export interface TxGroup {
  /** `${chainId}:${blockHash}:${txHash}` (lowercase). */
  id: string;
  chainId: number;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: Date;
  txHash: string;
  finality: ChainEventInternal["finality"];
  /** Sorted by log index. */
  events: ChainEvent[];
  firstLogIndex: number;
  fingerprint: string;
}

const HASH_RE = /^0x[0-9a-f]{64}$/;

export function lower(value: string): string {
  return value.toLowerCase();
}

/** Checksummed address, or `null` when the value is not an address. */
export function addressOf(value: string | undefined): string | null {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) return null;
  return getAddress(value);
}

/** Non-negative integer argument, or `null`. */
export function uintOf(value: string | undefined): bigint | null {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  return BigInt(value);
}

export function txGroupId(chainId: number, blockHash: string, txHash: string): string {
  return `${chainId}:${lower(blockHash)}:${lower(txHash)}`;
}

export function eventId(chainId: number, blockHash: string, txHash: string, logIndex: number): string {
  return `${txGroupId(chainId, blockHash, txHash)}:${logIndex}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function crockford(value: bigint, length: number): string {
  let out = "";
  let rest = value;
  for (let i = 0; i < length; i++) {
    out = (CROCKFORD[Number(rest % 32n)] as string) + out;
    rest /= 32n;
  }
  return out;
}

/**
 * The ledger's `chainEventId` for an event: a `cev_` id whose ULID body is the block time
 * (ms) and 80 bits of sha256(event id). Deterministic, so a retried posting hashes identically,
 * and distinct per event.
 */
export function ledgerRefOf(id: string, blockTimestampSeconds: number): string {
  const time = BigInt(Math.max(0, Math.min(blockTimestampSeconds, 2 ** 47 / 1000))) * 1000n;
  const digest = BigInt(sha256(stringToBytes(id)).slice(0, 22));
  return `cev_${crockford(time, 10)}${crockford(digest, 16)}`;
}

function normalizedArgs(args: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args))
    out[key] = /^0x[0-9a-fA-F]*$/.test(value) ? lower(value) : value;
  return out;
}

/**
 * Fingerprint of what a transaction did: its value-relevant logs in order, without anything
 * block-specific (block, log index, gas). A re-included transaction with the same fingerprint
 * moved exactly the same money between the same parties.
 */
export function fingerprintOf(events: readonly ChainEvent[]): string {
  return canonicalSha256(
    events.map((e) =>
      e.name === "UserOperationEvent"
        ? [
            e.contract,
            e.name,
            lower(e.args.userOpHash ?? ""),
            lower(e.args.sender ?? ""),
            e.args.success ?? "",
          ]
        : [e.contract, e.name, normalizedArgs(e.args)],
    ),
  );
}

/**
 * Validate and group a request's events per transaction, keeping canonical order. A
 * transaction's logs are never split across requests, but they may be interleaved with nothing
 * else: every event of a group is in one block.
 */
export function groupEvents(chainId: number, events: readonly ChainEventInternal[]): TxGroup[] {
  const groups = new Map<string, TxGroup>();
  const seen = new Set<string>();
  for (const raw of events) {
    if (raw.chain_id !== chainId) {
      throw new AgentBankError(
        "invalid_request",
        `Event ${raw.id} is on chain ${raw.chain_id}, not ${chainId}`,
      );
    }
    const blockHash = lower(raw.block_hash);
    const txHash = lower(raw.tx_hash);
    if (!HASH_RE.test(blockHash) || !HASH_RE.test(txHash)) {
      throw new AgentBankError(
        "invalid_request",
        `Event ${raw.id} has a malformed block or transaction hash`,
      );
    }
    const id = eventId(chainId, blockHash, txHash, raw.log_index);
    if (lower(raw.id) !== id) {
      throw new AgentBankError("invalid_request", `Event id ${raw.id} is not ${id}`);
    }
    if (seen.has(id))
      throw new AgentBankError("invalid_request", `Event ${raw.id} appears twice in the request`);
    seen.add(id);
    const groupId = txGroupId(chainId, blockHash, txHash);
    let group = groups.get(groupId);
    if (!group) {
      group = {
        id: groupId,
        chainId,
        blockNumber: BigInt(raw.block_number),
        blockHash,
        blockTimestamp: new Date(raw.block_timestamp * 1000),
        txHash,
        finality: raw.finality,
        events: [],
        firstLogIndex: raw.log_index,
        fingerprint: "",
      };
      groups.set(groupId, group);
    } else if (group.blockNumber !== BigInt(raw.block_number)) {
      throw new AgentBankError("invalid_request", `Event ${raw.id} disagrees with its block number`);
    }
    group.events.push({
      sentId: raw.id,
      id,
      ledgerRef: ledgerRefOf(id, raw.block_timestamp),
      logIndex: raw.log_index,
      contract: lower(raw.contract),
      name: raw.event_name,
      args: raw.args,
      userOpHash: raw.user_op_hash ? lower(raw.user_op_hash) : null,
      raw,
    });
  }
  for (const group of groups.values()) {
    group.events.sort((a, b) => a.logIndex - b.logIndex);
    group.firstLogIndex = group.events[0]?.logIndex ?? 0;
    group.fingerprint = fingerprintOf(group.events);
  }
  return [...groups.values()];
}

/** A USDC `Transfer`. */
export interface TransferLog {
  event: ChainEvent;
  from: string;
  to: string;
  value: bigint;
}

/** EIP-3009 `AuthorizationUsed`. */
export interface AuthorizationLog {
  event: ChainEvent;
  authorizer: string;
  nonce: string;
}

/** Typed views of a group's events. Events of tokens other than USDC are left out. */
export function transfersOf(group: TxGroup, usdc: string): TransferLog[] {
  const out: TransferLog[] = [];
  for (const event of group.events) {
    if (event.name !== "Transfer" || event.contract !== usdc) continue;
    const from = addressOf(event.args.from);
    const to = addressOf(event.args.to);
    const value = uintOf(event.args.value);
    if (from === null || to === null || value === null || value === 0n) continue;
    out.push({ event, from, to, value });
  }
  return out;
}

export function authorizationsOf(group: TxGroup, usdc: string): AuthorizationLog[] {
  const out: AuthorizationLog[] = [];
  for (const event of group.events) {
    if (event.name !== "AuthorizationUsed" || event.contract !== usdc) continue;
    const authorizer = addressOf(event.args.authorizer);
    const nonce = event.args.nonce;
    if (authorizer === null || typeof nonce !== "string" || !HASH_RE.test(lower(nonce))) continue;
    out.push({ event, authorizer, nonce: lower(nonce) });
  }
  return out;
}

/** User operation hashes the group's events belong to (from `user_op_hash` and `UserOperationEvent`). */
export function userOpHashesOf(group: TxGroup): string[] {
  const hashes = new Set<string>();
  for (const event of group.events) {
    if (event.userOpHash) hashes.add(event.userOpHash);
    if (
      event.name === "UserOperationEvent" &&
      event.args.userOpHash &&
      HASH_RE.test(lower(event.args.userOpHash))
    ) {
      hashes.add(lower(event.args.userOpHash));
    }
  }
  return [...hashes];
}
