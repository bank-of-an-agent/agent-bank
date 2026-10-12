import type { ChainGateway } from "@agentbank/chain";
import type { SimulatedChain } from "@agentbank/chain/simulated";
import type { Clock, CosignerClient } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { Ledger } from "@agentbank/ledger";
import type { Config } from "./config";
import type { Reconciler } from "./http/internal";
import type { Logger } from "./logger";
import type { KybProvider } from "./providers/kyb";
import type { ScreeningProvider } from "./providers/screening";

/**
 * Everything the API depends on, injected into `buildApp` and the worker. Production wiring
 * lives in `src/wiring.ts`; tests build their own (PGlite, SimulatedChain, in-memory or
 * Postgres ledger, an in-process fake co-signer, a manual clock).
 */
export interface AppDeps {
  config: Config;
  db: SqlClient;
  ledger: Ledger;
  chain: ChainGateway;
  cosigner: CosignerClient;
  clock: Clock;
  screening: ScreeningProvider;
  kyb: KybProvider;
  logger: Logger;
  /** `@agentbank/reconciliation`, mounted on `/internal/*` for the indexer. Optional. */
  reconciler?: Reconciler;
  /** The in-memory chain behind `chain` on `AGENTBANK_CHAIN=simulated` (faucet, dev block producer). */
  simulator?: SimulatedChain;
  /** Releases resources beyond the database (the in-process co-signer). */
  close?: () => Promise<void>;
}
