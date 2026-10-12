import type { SqlClient } from "@agentbank/db";
import { PostgresLedger, type Ledger } from "@agentbank/ledger";
import type { AppDeps } from "../deps";

/**
 * The ledger bound to a caller's transaction. With the Postgres ledger, writes then commit (or
 * roll back) together with the caller's own rows, and the outer SERIALIZABLE transaction's
 * retry covers serialization failures. The in-memory ledger (tests) cannot join a database
 * transaction; its writes are idempotent by key instead.
 */
export function ledgerIn(deps: AppDeps, tx: SqlClient): Ledger {
  return deps.ledger instanceof PostgresLedger ? new PostgresLedger(tx, { clock: deps.clock }) : deps.ledger;
}
