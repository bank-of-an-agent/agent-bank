import {
  anvilForkContracts,
  baseSepoliaContracts,
  contractsFromDeployment,
  EvmChainGateway,
  pimlicoUrl,
  type AgentBankDeploymentFile,
  type ChainGateway,
} from "@agentbank/chain";
import type { SimulatedChain } from "@agentbank/chain/simulated";
import { registerAsset, systemClock, type Clock, type CosignerClient } from "@agentbank/core";
import { createSqlClient, loadMigrations, migrate, MIGRATIONS_DIR, type SqlClient } from "@agentbank/db";
import { PostgresLedger } from "@agentbank/ledger";
import { createReconciler } from "@agentbank/reconciliation";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config";
import { HttpCosignerClient } from "./cosigner/http-client";
import { unavailableCosigner } from "./cosigner/unavailable";
import type { AppDeps } from "./deps";
import { createInProcessCosigner } from "./dev/inprocess-cosigner";
import type { Reconciler } from "./http/internal";
import type { Logger } from "./logger";
import { SandboxKyb } from "./providers/kyb";
import { SandboxScreening } from "./providers/screening";

/**
 * Production wiring: real Postgres, the Postgres ledger, the EVM gateway (or the simulated
 * chain for the local sandbox), the HTTP co-signer (fail closed when unconfigured) and the
 * vendor adapters. Shared by the HTTP server and the worker.
 */

/** Migrations next to the bundle (`dist/migrations`) when built, else the db package's. */
export function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const bundled = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");
  return existsSync(bundled) ? bundled : MIGRATIONS_DIR;
}

export async function createChain(
  config: Config,
  clock: Clock,
): Promise<{ gateway: ChainGateway; simulator?: SimulatedChain }> {
  if (config.chain.name === "simulated") {
    const { SimulatedChain } = await import("@agentbank/chain/simulated");
    // Short finality so local settlement takes seconds (a block every SIMULATED_BLOCK_TIME_MS).
    const simulator = new SimulatedChain({ chainId: config.chain.id, clock, safeDepth: 1, finalityDepth: 3 });
    return { gateway: simulator.gateway, simulator };
  }
  const base = config.chain.name === "anvil" ? anvilForkContracts() : baseSepoliaContracts();
  const contracts = config.deployment
    ? contractsFromDeployment(base, config.deployment as unknown as AgentBankDeploymentFile)
    : base;
  if (config.chain.name === "anvil") {
    // Core registers no USDC for Anvil: use the deployment's MockUSDC (or the fork's USDC).
    registerAsset({
      code: "USDC",
      chainId: config.chain.id,
      address: contracts.usdc,
      decimals: 6,
      eip712: { name: "USDC", version: "2" },
    });
  }
  const bundlerUrl =
    config.bundlerUrl ??
    (config.pimlicoApiKey ? pimlicoUrl(config.chain.id, config.pimlicoApiKey) : undefined);
  const gateway = new EvmChainGateway({
    chainId: config.chain.id,
    rpcUrl: config.rpcUrl as string,
    contracts,
    ...(bundlerUrl ? { bundlerUrl } : {}),
    ...(config.pimlicoSponsorshipPolicyId
      ? { paymasterContext: { sponsorshipPolicyId: config.pimlicoSponsorshipPolicyId } }
      : {}),
    ...(config.relayerKey ? { relayer: privateKeyToAccount(config.relayerKey) } : {}),
  });
  return { gateway };
}

/** The reconciler mounted on `/internal/*` for the indexer (`@agentbank/reconciliation`). */
export function createApiReconciler(deps: Omit<AppDeps, "reconciler">): Reconciler {
  const contracts = deps.chain.contracts;
  const ledger = deps.ledger;
  return createReconciler({
    db: deps.db,
    // Postgres: one ledger per reconciliation transaction (entries commit with their rows).
    ledger:
      ledger instanceof PostgresLedger
        ? (tx: SqlClient) => new PostgresLedger(tx, { clock: deps.clock })
        : ledger,
    cosigner: deps.cosigner,
    clock: deps.clock,
    config: {
      chainId: deps.config.chain.id,
      usdc: contracts.usdc,
      revenueAddress: deps.config.revenueAddress,
      contracts: {
        escrow: contracts.escrow ?? null,
        streams: contracts.streams ?? null,
        vaults: contracts.vaults ?? null,
        topUpExecutor: contracts.topUpExecutor ?? null,
        sweepExecutor: contracts.sweepExecutor ?? null,
      },
    },
    logger: deps.logger,
  });
}

export async function createDeps(config: Config, logger: Logger, db?: SqlClient): Promise<AppDeps> {
  const sql = db ?? (await createSqlClient(config.databaseUrl, { statementTimeoutMs: 30_000 }));
  if (config.migrateOnStart) {
    const ran = await migrate(sql, loadMigrations(migrationsDir()));
    if (ran.length > 0) logger.info({ migrations: ran }, "applied migrations");
  }
  const clock = systemClock;
  const { gateway, simulator } = await createChain(config, clock);
  let cosigner: CosignerClient = unavailableCosigner;
  let close: (() => Promise<void>) | undefined;
  if (config.cosigner.mode === "inprocess") {
    const inProcess = await createInProcessCosigner(config, gateway, clock, logger);
    cosigner = inProcess.client;
    close = inProcess.close;
  } else if (config.cosigner.url) {
    cosigner = new HttpCosignerClient({
      url: config.cosigner.url,
      sharedSecret: config.cosigner.sharedSecret,
      timeoutMs: config.cosigner.timeoutMs,
    });
  }
  const base = {
    config,
    db: sql,
    ledger: new PostgresLedger(sql, { clock }),
    chain: gateway,
    cosigner,
    clock,
    screening: new SandboxScreening(config.screening.denylist),
    kyb: new SandboxKyb(),
    logger,
    ...(simulator ? { simulator } : {}),
    ...(close ? { close } : {}),
  };
  return { ...base, reconciler: createApiReconciler(base) };
}
