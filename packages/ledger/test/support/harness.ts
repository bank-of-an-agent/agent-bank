import { AgentBankError, CHAINS, ManualClock, newId, type ErrorCode } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import { expect } from "vitest";
import {
  chainRef,
  InMemoryLedger,
  pocketRef,
  PostgresLedger,
  type HoldSource,
  type JournalEntry,
  type Ledger,
  type PostEntryInput,
} from "../../src";
import { freshDatabase } from "./database";

/** Chain used by the tests (the in-memory simulated testnet). */
export const CHAIN = CHAINS.simulated.id;
/** Assets the test ledgers accept; EURC exists so multi-asset entries can be tested. */
export const ASSETS = ["USDC", "EURC"] as const;
export const HOUR = 3_600_000;

export interface Harness {
  name: "memory" | "postgres";
  ledger: Ledger;
  clock: ManualClock;
  /** Raw SQL access to the ledger's database (Postgres harness only). */
  db: SqlClient | null;
  close(): Promise<void>;
}

export interface HarnessOptions {
  clock?: ManualClock;
  retries?: number;
}

export type HarnessFactory = (options?: HarnessOptions) => Promise<Harness>;

export const memoryHarness: HarnessFactory = async (options = {}) => {
  const clock = options.clock ?? new ManualClock();
  return {
    name: "memory",
    ledger: new InMemoryLedger({ clock, assets: ASSETS }),
    clock,
    db: null,
    close: async () => undefined,
  };
};

export const postgresHarness: HarnessFactory = async (options = {}) => {
  const clock = options.clock ?? new ManualClock();
  const { db, close } = await freshDatabase();
  return {
    name: "postgres",
    ledger: new PostgresLedger(db, { clock, assets: ASSETS, retries: options.retries ?? 60 }),
    clock,
    db,
    close,
  };
};

let sequence = 0;

/** A fresh idempotency key. */
export function key(label = "op"): string {
  sequence += 1;
  return `${label}:${sequence}`;
}

/** A bank account with all standard pockets on {@link CHAIN}. */
export async function openAccount(ledger: Ledger, asset = "USDC"): Promise<string> {
  const accountId = newId("account");
  await ledger.openPockets(accountId, asset, CHAIN);
  return accountId;
}

/** Inbound deposit: `sys:chain −x`, `operating +x`. */
export function deposit(
  ledger: Ledger,
  accountId: string,
  amount: bigint,
  asset = "USDC",
  extra: Partial<PostEntryInput> = {},
): Promise<JournalEntry> {
  return ledger.post({
    idempotencyKey: key("deposit"),
    refType: "deposit",
    lines: [
      { account: chainRef(CHAIN, asset), amount: -amount },
      { account: pocketRef(accountId, "operating", asset), amount },
    ],
    ...extra,
  });
}

/** Move funds between two pockets of one account (e.g. operating → spend float). */
export function movePockets(
  ledger: Ledger,
  accountId: string,
  from: string,
  to: string,
  amount: bigint,
  asset = "USDC",
): Promise<JournalEntry> {
  return ledger.post({
    idempotencyKey: key("move"),
    refType: "transfer",
    lines: [
      { account: { ownerRef: accountId, code: `pocket:${from}`, asset }, amount: -amount },
      { account: { ownerRef: accountId, code: `pocket:${to}`, asset }, amount },
    ],
  });
}

/** Place a one-hour hold. */
export function placeHold(
  harness: Harness,
  accountId: string,
  amount: bigint,
  from: HoldSource = "operating",
  extra: Record<string, unknown> = {},
) {
  return harness.ledger.hold({
    idempotencyKey: key("hold"),
    accountId,
    asset: "USDC",
    amount,
    from,
    expiresAt: new Date(harness.clock.now().getTime() + HOUR),
    refType: "payment",
    ...extra,
  });
}

/** Await a rejection and check it is an `AgentBankError` with `code`. */
export async function rejects(promise: Promise<unknown>, code: ErrorCode): Promise<AgentBankError> {
  const error: unknown = await promise.then(
    () => new Error(`expected an AgentBankError "${code}", but the call succeeded`),
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AgentBankError);
  expect((error as AgentBankError).code).toBe(code);
  return error as AgentBankError;
}
