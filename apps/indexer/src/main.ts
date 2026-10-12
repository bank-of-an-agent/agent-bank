import {
  anvilForkContracts,
  baseSepoliaContracts,
  EvmChainGateway,
  withAgentBankContracts,
  type ChainContracts,
  type ChainGateway,
} from "@agentbank/chain";
import { SimulatedChain } from "@agentbank/chain/simulated";
import { createSqlClient } from "@agentbank/db";
import { getAddress } from "viem";
import { buildApp } from "./app";
import { loadConfig, type IndexerConfig } from "./config";
import { Indexer, type IndexerLogger } from "./indexer";
import { IndexerMetrics } from "./metrics";
import { IndexerStore, migrateIndexer } from "./store";
import { HttpReconcilerTransport } from "./transport";

/**
 * Indexer entry point (`dist/index.js`). `node dist/index.js` runs the server and the polling
 * loop; `node dist/index.js balance-check` runs one on-chain balance check and exits.
 */

function jsonLogger(level: string): IndexerLogger {
  const quiet = level === "silent";
  const write = (lvl: string, obj: Record<string, unknown>, msg?: string) => {
    if (quiet) return;
    const line = JSON.stringify({ level: lvl, time: new Date().toISOString(), msg, ...obj });
    if (lvl === "error" || lvl === "warn") console.error(line);
    else process.stdout.write(`${line}\n`);
  };
  return {
    info: (obj, msg) => {
      if (level === "info" || level === "debug" || level === "trace") write("info", obj, msg);
    },
    warn: (obj, msg) => write("warn", obj, msg),
    error: (obj, msg) => write("error", obj, msg),
  };
}

/** The gateway for the configured chain; Agent Bank contracts come from the API's watchlist. */
async function gatewayFor(config: IndexerConfig, transport: HttpReconcilerTransport): Promise<ChainGateway> {
  if (config.chain.name === "simulated") {
    // Process-local simulator: useful only for smoke runs (the API's simulated chain lives in the API process).
    return new SimulatedChain().gateway;
  }
  const watchlist = await transport.watchlist();
  const contract = (kind: string) => {
    const found = watchlist.addresses.find((a) => a.kind === kind);
    return found ? getAddress(found.address) : undefined;
  };
  const base = config.chain.name === "anvil" ? anvilForkContracts() : baseSepoliaContracts();
  const contracts: ChainContracts = withAgentBankContracts(
    { ...base, usdc: getAddress(watchlist.usdc) },
    {
      ...(contract("escrow_contract") ? { escrow: contract("escrow_contract") } : {}),
      ...(contract("streams_contract") ? { streams: contract("streams_contract") } : {}),
      ...(contract("vaults_contract") ? { vaults: contract("vaults_contract") } : {}),
      ...(contract("topup_executor") ? { topUpExecutor: contract("topup_executor") } : {}),
      ...(contract("sweep_executor") ? { sweepExecutor: contract("sweep_executor") } : {}),
    },
  );
  return new EvmChainGateway({ chainId: config.chain.id, rpcUrl: config.rpcUrl as string, contracts });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = jsonLogger(config.logLevel);
  const db = await createSqlClient(config.databaseUrl, { max: 4, statementTimeoutMs: 30_000 });
  await migrateIndexer(db);
  const transport = new HttpReconcilerTransport({
    baseUrl: config.apiInternalUrl,
    secret: config.internalSecret,
    timeoutMs: config.httpTimeoutMs,
  });
  const chain = await gatewayFor(config, transport);
  const indexer = new Indexer({
    chain,
    transport,
    store: new IndexerStore(db, config.chain.id),
    windowBlocks: config.windowBlocks,
    maxBlocksPerTick: config.maxBlocksPerTick,
    batchEvents: config.batchEvents,
    reorgHistory: config.reorgHistory,
    watchlistRefreshMs: config.watchlistRefreshMs,
    ...(config.startBlock !== undefined ? { startBlock: config.startBlock } : {}),
    balanceCheckContracts: config.balanceCheckContracts,
    balanceCheckHourUtc: config.balanceCheckHourUtc,
    logger,
    metrics: new IndexerMetrics({
      indexerNamespace: config.metricsNamespace,
      reconciliationNamespace: config.reconciliationMetricsNamespace,
    }),
  });

  if (process.argv.includes("balance-check")) {
    await indexer.tick();
    const result = await indexer.balanceCheck();
    logger.warn(
      {
        result: result
          ? { block: result.blockNumber.toString(), checked: result.checked, mismatches: result.mismatches }
          : null,
      },
      "balance check done",
    );
    await db.close();
    process.exit(result && result.mismatches.length === 0 ? 0 : 1);
  }

  const app = buildApp({ indexer, secret: config.internalSecret, logLevel: config.logLevel });
  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), 25_000);
    try {
      await indexer.stop();
      await app.close();
      await db.close();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  await app.listen({ host: config.host, port: config.port });
  indexer.start(config.pollIntervalMs);
  logger.warn(
    { chain: config.chain.name, chain_id: config.chain.id, port: config.port, window: config.windowBlocks },
    "indexer started",
  );
}

main().catch((error: unknown) => {
  console.error("indexer failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
