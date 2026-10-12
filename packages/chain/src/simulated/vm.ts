import {
  encodeAbiParameters,
  encodeErrorResult,
  getAddress,
  toEventSelector,
  type Abi,
  type AbiEvent,
  type AbiParameter,
  type Address,
  type ContractErrorArgs,
  type ContractErrorName,
  type EncodeErrorResultParameters,
  type Hex,
} from "viem";
import { formatContractError } from "../attestations";
import type { Journal } from "./journal";

/** A revert inside the simulator (the EVM `revert`). */
export class SimRevert extends Error {
  /**
   * @param reason Human-readable reason (`Name(arg, ...)` for custom errors).
   * @param data ABI-encoded revert data, when the revert is a custom error from an ABI.
   */
  constructor(
    readonly reason: string,
    readonly data?: Hex,
  ) {
    super(reason);
    this.name = "SimRevert";
  }
}

/** Revert with `reason`. */
export function revert(reason: string): never {
  throw new SimRevert(reason);
}

/**
 * Revert with a custom error of `abi`, exactly as Solidity's `revert Name(args)`: the data is the
 * ABI-encoded error and the reason is `Name(arg, ...)` (see `formatContractError`).
 */
export function revertWith<const abi extends Abi, name extends ContractErrorName<abi>>(
  abi: abi,
  errorName: name,
  ...args: ContractErrorArgs<abi, name> extends readonly [] ? [] : [ContractErrorArgs<abi, name>]
): never {
  const values = (args[0] ?? []) as readonly unknown[];
  const data = encodeErrorResult({ abi, errorName, args: values } as unknown as EncodeErrorResultParameters);
  throw new SimRevert(formatContractError(errorName, values), data);
}

/** `require(condition, reason)`. */
export function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new SimRevert(reason);
}

/** A log before it is sealed into a block. */
export interface LogDraft {
  address: Address;
  topics: Hex[];
  data: Hex;
}

/** Execution context of one transaction. */
export interface ExecContext {
  blockNumber: bigint;
  /** Block timestamp (unix seconds). */
  timestamp: number;
  txHash: Hex;
  logs: LogDraft[];
  journal: Journal;
}

const selectors = new WeakMap<AbiEvent, Hex>();

/** Encode an event's topics and data (indexed arguments are value types in every Agent Bank event). */
export function encodeLog(event: AbiEvent, args: Record<string, unknown>): { topics: Hex[]; data: Hex } {
  let topic0 = selectors.get(event);
  if (!topic0) {
    topic0 = toEventSelector(event);
    selectors.set(event, topic0);
  }
  const topics: Hex[] = [topic0];
  const nonIndexed: AbiParameter[] = [];
  for (const input of event.inputs) {
    if (input.indexed) topics.push(encodeAbiParameters([input], [args[input.name as string]]));
    else nonIndexed.push(input);
  }
  const data =
    nonIndexed.length === 0
      ? "0x"
      : encodeAbiParameters(
          nonIndexed,
          nonIndexed.map((i) => args[i.name as string]),
        );
  return { topics, data };
}

/** Emit an event (journaled: discarded if the surrounding call reverts). */
export function emitLog(
  ctx: ExecContext,
  address: Address,
  event: AbiEvent,
  args: Record<string, unknown>,
): void {
  const { topics, data } = encodeLog(event, args);
  const n = ctx.logs.length;
  ctx.logs.push({ address: getAddress(address), topics, data });
  ctx.journal.record(() => {
    ctx.logs.length = n;
  });
}

/** Event ABI item by name from an ABI. */
export function eventOf(abi: readonly { type: string; name?: string }[], name: string): AbiEvent {
  const item = abi.find((i) => i.type === "event" && i.name === name);
  if (!item) throw new Error(`event ${name} not in ABI`);
  return item as AbiEvent;
}

/** Lowercase key helper for maps keyed by addresses and ids. */
export function key(...parts: (string | bigint | number)[]): string {
  return parts.map((p) => (typeof p === "string" ? p.toLowerCase() : p.toString())).join(":");
}

/** Seconds per day (UTC-day buckets). */
export const DAY = 86_400;
