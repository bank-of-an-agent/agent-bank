import { AgentBankError, type AuditRecord, type Clock, type TypedDataVerifier } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { Address } from "viem";
import type { PolicyEvaluator } from "./evaluator";
import type { Metrics } from "./metrics";
import type { OperationCodec } from "./operation";
import type { CosignerSigner } from "./signer/types";
import * as store from "./store";

export interface ServiceConfig {
  /** The one chain this co-signer serves. */
  chainId: number;
  /** Agent Bank revenue address: the only extra payee an operation may carry (fees). */
  revenueAddress: Address;
  /** Largest sweep of accrued fees one operation may carry, minor units. */
  maxFeeSweep: bigint;
  /** `COSIGNER_FAIL_CLOSED=true`: refuse every evaluation, co-signature and x402 authorization. */
  failClosed: boolean;
  /** EIP-712 domain chain id of owner authorizations (`OWNER_AUTHORIZATION_CHAIN_ID`); default `chainId`. */
  ownerAuthorizationChainId?: number | undefined;
}

export interface Logger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Ships committed audit records somewhere durable outside the database (the
 * infrastructure provides an S3 Object Lock bucket, `AUDIT_LOG_BUCKET` /
 * `AUDIT_LOG_PREFIX`). Called after commit, best effort: the hash-chained
 * table remains the source of truth and can be re-exported from any `seq`.
 */
export interface AuditExporter {
  export(records: readonly AuditRecord[]): Promise<void>;
}

export const noopAuditExporter: AuditExporter = { export: async () => undefined };

/** Everything the co-signer's flows share. */
export interface ServiceContext {
  db: SqlClient;
  signer: CosignerSigner;
  chain: OperationCodec;
  config: ServiceConfig;
  clock: Clock;
  evaluator: PolicyEvaluator;
  exporter: AuditExporter;
  metrics?: Metrics | undefined;
  verifier?: TypedDataVerifier | undefined;
  log?: Logger | undefined;
}

/** Append to the audit hash chain inside the current transaction. */
export type AuditFn = (entry: store.AuditEntry) => Promise<AuditRecord>;

/**
 * Run `fn` in a READ COMMITTED transaction. Isolation comes from explicit
 * row locks: the agent row for anything that reads then extends spend
 * history, the audit head (taken last) for the hash chain. Audit records
 * appended through `audit` are exported once the transaction commits.
 */
export async function transaction<T>(
  ctx: ServiceContext,
  fn: (tx: SqlClient, audit: AuditFn) => Promise<T>,
): Promise<T> {
  let appended: AuditRecord[] = [];
  const result = await ctx.db.transaction(
    async (tx) => {
      appended = []; // a retried transaction starts over
      return fn(tx, async (entry) => {
        const record = await store.appendAudit(tx, entry);
        appended.push(record);
        return record;
      });
    },
    { isolation: "read committed" },
  );
  if (appended.length > 0) {
    const records = appended;
    ctx.exporter.export(records).catch((error: unknown) => {
      ctx.log?.warn(
        { err: error, from: records[0]?.seq, to: records.at(-1)?.seq },
        "audit export failed; records stay in the database",
      );
    });
  }
  return result;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Identifiers become audit subjects and SQL keys: printable, short, unambiguous. */
export function assertIds(ids: Record<string, string | undefined>): void {
  for (const [field, value] of Object.entries(ids)) {
    if (value !== undefined && !SAFE_ID.test(value)) {
      throw new AgentBankError("invalid_request", `${field} must be 1-128 characters of [A-Za-z0-9_.:-]`);
    }
  }
}

export function assertChain(ctx: ServiceContext, chainId: number): void {
  if (chainId !== ctx.config.chainId) {
    throw new AgentBankError(
      "unsupported_chain",
      `This co-signer serves chain ${ctx.config.chainId}, not ${chainId}`,
    );
  }
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}
