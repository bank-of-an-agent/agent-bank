import { decodeEventLog, getAddress, toEventSelector, type AbiEvent, type Address, type Hex } from "viem";
import {
  agentEscrowAbi,
  agentPolicyHookAbi,
  entryPointAbi,
  erc20Abi,
  paymentStreamsAbi,
  smartSessionsAbi,
  timeLockVaultsAbi,
  topUpExecutorAbi,
} from "./abis";
import { CHAIN_EVENT_NAMES, type ChainContracts, type ChainEventName, type ChainLog } from "./types";

/** Which contract (in {@link ChainContracts}) emits each event. */
export const EVENT_SOURCE: Record<ChainEventName, keyof ChainContracts> = {
  Transfer: "usdc",
  Approval: "usdc",
  AuthorizationUsed: "usdc",
  AuthorizationCanceled: "usdc",
  Locked: "escrow",
  ValidationConfigured: "escrow",
  Released: "escrow",
  Refunded: "escrow",
  Disputed: "escrow",
  Resolved: "escrow",
  StreamCreated: "streams",
  StreamToppedUp: "streams",
  StreamSettled: "streams",
  StreamCanceled: "streams",
  StreamSettlementDeferred: "streams",
  VaultCreated: "vaults",
  Deposited: "vaults",
  Withdrawn: "vaults",
  OwnerChanged: "vaults",
  ToppedUp: "topUpExecutor",
  SpendRecorded: "policyHook",
  SessionCreated: "smartSessions",
  SessionRemoved: "smartSessions",
  UserOperationEvent: "entryPoint",
  UserOperationRevertReason: "entryPoint",
  AccountDeployed: "entryPoint",
};

function eventsOf(abi: readonly { type: string; name?: string }[]): AbiEvent[] {
  return abi.filter((item) => item.type === "event") as AbiEvent[];
}

const ALL_EVENTS: AbiEvent[] = [
  ...eventsOf(erc20Abi),
  ...eventsOf(agentEscrowAbi),
  ...eventsOf(paymentStreamsAbi),
  ...eventsOf(timeLockVaultsAbi),
  ...eventsOf(topUpExecutorAbi),
  ...eventsOf(agentPolicyHookAbi),
  ...eventsOf(smartSessionsAbi),
  ...eventsOf(entryPointAbi),
];

/** ABI items of every {@link ChainEventName} (one per name). */
export const CHAIN_EVENTS: Record<ChainEventName, AbiEvent> = Object.fromEntries(
  CHAIN_EVENT_NAMES.map((name) => {
    const item = ALL_EVENTS.find((e) => e.name === name);
    if (!item) throw new Error(`missing ABI for event ${name}`);
    return [name, item];
  }),
) as Record<ChainEventName, AbiEvent>;

/** topic0 of every known event. */
export const EVENT_TOPICS: Record<ChainEventName, Hex> = Object.fromEntries(
  CHAIN_EVENT_NAMES.map((name) => [name, toEventSelector(CHAIN_EVENTS[name])]),
) as Record<ChainEventName, Hex>;

const NAME_BY_TOPIC = new Map<string, ChainEventName>(
  CHAIN_EVENT_NAMES.map((name) => [EVENT_TOPICS[name].toLowerCase(), name]),
);

/** Emitting address of an event on a chain, or `undefined` if that contract is not deployed. */
export function eventSourceAddress(name: ChainEventName, contracts: ChainContracts): Address | undefined {
  const value = contracts[EVENT_SOURCE[name]];
  return typeof value === "string" ? getAddress(value) : undefined;
}

/** String form of a decoded scalar event argument (see {@link ChainLog}). */
export function eventArgToString(value: unknown): string {
  switch (typeof value) {
    case "bigint":
    case "number":
      return value.toString();
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return /^0x[0-9a-fA-F]{40}$/.test(value) ? getAddress(value) : value.toLowerCase();
    default:
      throw new TypeError(`unsupported event argument ${typeof value}`);
  }
}

/** A raw log as returned by an RPC node or recorded by the simulator. */
export interface RawLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}

/**
 * Decode and normalize a raw log if it is a known event emitted by the contract that owns that event
 * on this chain; otherwise `null` (lookalike events from other contracts are ignored).
 */
export function normalizeLog(log: RawLog, chainId: number, contracts: ChainContracts): ChainLog | null {
  const topic0 = log.topics[0]?.toLowerCase();
  if (!topic0) return null;
  const name = NAME_BY_TOPIC.get(topic0);
  if (!name) return null;
  const source = eventSourceAddress(name, contracts);
  if (!source || source !== getAddress(log.address)) return null;
  let decoded;
  try {
    decoded = decodeEventLog({
      abi: [CHAIN_EVENTS[name]],
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
  } catch {
    return null;
  }
  return {
    chainId,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    address: getAddress(log.address),
    eventName: name,
    args: Object.fromEntries(
      Object.entries(decoded.args as Record<string, unknown>).map(([k, v]) => [k, eventArgToString(v)]),
    ),
  };
}

/**
 * The arguments of each event that name a party (an account whose funds or permissions the event
 * is about). `LogQuery.involving` matches these, identically on every gateway. Contract-internal
 * arguments (tokens, factories, paymasters) are not parties. Events about an escrow, stream or vault
 * by id do not always name every party: index those contracts' events without `involving`.
 */
export const EVENT_PARTIES: Record<ChainEventName, readonly string[]> = {
  Transfer: ["from", "to"],
  Approval: ["owner", "spender"],
  AuthorizationUsed: ["authorizer"],
  AuthorizationCanceled: ["authorizer"],
  Locked: ["payer", "payee", "arbiter"],
  ValidationConfigured: ["validator"],
  Released: ["payee", "caller"],
  Refunded: ["payer", "caller"],
  Disputed: ["disputant"],
  Resolved: ["arbiter"],
  StreamCreated: ["payer", "payee"],
  StreamToppedUp: ["payer"],
  StreamSettled: ["payee", "caller"],
  StreamCanceled: ["canceledBy"],
  StreamSettlementDeferred: ["payee"],
  VaultCreated: ["account", "owner"],
  Deposited: ["from"],
  Withdrawn: ["account", "caller"],
  OwnerChanged: ["previousOwner", "newOwner"],
  ToppedUp: ["treasury", "agent"],
  SpendRecorded: ["account"],
  SessionCreated: ["account"],
  SessionRemoved: ["smartAccount"],
  UserOperationEvent: ["sender"],
  UserOperationRevertReason: ["sender"],
  AccountDeployed: ["sender"],
};

/** Topic positions (1-based) of an event's party arguments, or `null` if any party argument is not indexed. */
export function partyTopicPositions(name: ChainEventName): number[] | null {
  const indexed = CHAIN_EVENTS[name].inputs.filter((i) => i.indexed).map((i) => i.name);
  const positions: number[] = [];
  for (const party of EVENT_PARTIES[name]) {
    const index = indexed.indexOf(party);
    if (index < 0) return null;
    positions.push(index + 1);
  }
  return positions;
}

/** Whether a party argument of the log (see {@link EVENT_PARTIES}) is one of `addresses` (lowercase set). */
export function logInvolves(log: ChainLog, addresses: ReadonlySet<string>): boolean {
  for (const party of EVENT_PARTIES[log.eventName]) {
    const value = log.args[party];
    if (typeof value === "string" && addresses.has(value.toLowerCase())) return true;
  }
  return false;
}

/** Sort logs by block number, then log index (canonical chain order). */
export function sortLogs<T extends Pick<ChainLog, "blockNumber" | "logIndex">>(logs: T[]): T[] {
  return logs.sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
}
