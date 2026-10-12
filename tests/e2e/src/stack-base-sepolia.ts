import {
  baseSepoliaContracts,
  contractsFromDeployment,
  erc20Abi,
  EvmChainGateway,
  pimlicoUrl,
  type AgentBankDeploymentFile,
} from "@agentbank/chain";
import { CHAINS, getAsset } from "@agentbank/core";
import { createSqlClient, loadMigrations, migrate, MIGRATIONS_DIR } from "@agentbank/db";
import { createCosigner, LocalSigner } from "@agentbank/cosigner";
import { PostgresLedger, type Ledger } from "@agentbank/ledger";
import type { Reconciler } from "@agentbank/reconciliation";
import {
  buildApp as buildFacilitatorApp,
  evmReceipts,
  Facilitator,
  SandboxScreening as FacilitatorScreening,
} from "../../../apps/facilitator/src/index";
import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../../../apps/api/src/app";
import { loadConfig } from "../../../apps/api/src/config";
import type { AppDeps } from "../../../apps/api/src/deps";
import { JOBS, runJob } from "../../../apps/api/src/jobs/index";
import { createLogger } from "../../../apps/api/src/logger";
import { SandboxKyb } from "../../../apps/api/src/providers/kyb";
import { SandboxScreening } from "../../../apps/api/src/providers/screening";
import { createApiReconciler } from "../../../apps/api/src/wiring";
import {
  HttpReconcilerTransport,
  Indexer,
  IndexerStore,
  migrateIndexer,
} from "../../../apps/indexer/src/index";
import { baseSepoliaEnv } from "./base-sepolia";
import { freePort, LOOPBACK } from "./net";
import type { StartStackOptions, Stack } from "./stack";
import { WorldClock } from "./world-clock";

/**
 * The stack against **real Base Sepolia** (Phase 3 gate). Same services as the simulated stack —
 * the API, co-signer, reconciler, indexer and facilitator over real HTTP — but the chain is the
 * live testnet through viem + Pimlico, with deployed contracts and funded keys supplied by a
 * human (see `base-sepolia.ts`). The clock is real (no time travel). This path never runs unless
 * `E2E_CHAIN=base-sepolia` and the credentials are present, and nothing is broadcast otherwise.
 */
export async function startBaseSepoliaStack(options: StartStackOptions = {}): Promise<Stack> {
  const env = baseSepoliaEnv();
  const clock = new WorldClock(); // installed at offset 0: real time, never advanced here
  const logLevel = options.logLevel ?? "warn";
  const logger = createLogger(logLevel);
  const chainId = CHAINS["base-sepolia"].id;
  const deployment = JSON.parse(env.deploymentJson) as AgentBankDeploymentFile;
  const contracts = contractsFromDeployment(baseSepoliaContracts(), deployment);
  const usdc = getAddress(contracts.usdc);

  const apiPort = options.apiPort ?? (await freePort());
  const facilitatorPort = options.facilitatorPort ?? (await freePort());
  const apiUrl = `http://${LOOPBACK}:${apiPort}`;
  const facilitatorUrl = `http://${LOOPBACK}:${facilitatorPort}/v1/x402`;
  const internalSecret = "e2e-internal-shared-secret-0123456789abcdef";
  const cosignerSecret = "e2e-cosigner-shared-secret-0123456789abcdef";
  const databaseUrl = process.env.DATABASE_URL ?? options.databaseUrl ?? "pglite://memory";

  const bundlerUrl = pimlicoUrl(chainId, env.pimlicoApiKey);
  const apiGateway = new EvmChainGateway({
    chainId,
    rpcUrl: env.rpcUrl,
    contracts,
    bundlerUrl,
    relayer: privateKeyToAccount(env.apiRelayerKey),
    ...(env.sponsorshipPolicyId
      ? { paymasterContext: { sponsorshipPolicyId: env.sponsorshipPolicyId } }
      : {}),
  });

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    AGENTBANK_CHAIN: "base-sepolia",
    CHAIN_RPC_URL: env.rpcUrl,
    PIMLICO_API_KEY: env.pimlicoApiKey,
    ...(env.sponsorshipPolicyId ? { PIMLICO_SPONSORSHIP_POLICY_ID: env.sponsorshipPolicyId } : {}),
    AGENTBANK_DEPLOYMENT_JSON: env.deploymentJson,
    REVENUE_ADDRESS: env.revenueAddress,
    API_RELAYER_KEY: env.apiRelayerKey,
    COSIGNER_SHARED_SECRET: cosignerSecret,
    INTERNAL_API_SHARED_SECRET: internalSecret,
    ALLOW_OPEN_SIGNUP: "true",
    PUBLIC_BASE_URL: apiUrl,
    FACILITATOR_PUBLIC_URL: facilitatorUrl,
    PAY_LINK_BASE_URL: apiUrl,
    RATE_LIMIT_PER_MINUTE: "1000000",
    LOG_LEVEL: logLevel,
    RUN_WORKER_IN_PROCESS: "false",
    ...options.env,
  });

  const db = await createSqlClient(databaseUrl, { statementTimeoutMs: 30_000 });
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  const cosignerDb = await createSqlClient(undefined);
  const signer = LocalSigner.create({ privateKey: env.apiRelayerKey, chainId, nodeEnv: "test" });
  const cosigner = await createCosigner({
    db: cosignerDb,
    signer,
    chain: apiGateway,
    sharedSecret: cosignerSecret,
    revenueAddress: config.revenueAddress,
    clock,
  });

  const ledger: Ledger = new PostgresLedger(db, { clock });
  const base = {
    config,
    db,
    ledger,
    chain: apiGateway,
    cosigner: cosigner.client,
    clock,
    screening: new SandboxScreening(config.screening.denylist),
    kyb: new SandboxKyb(),
    logger,
  };
  const deps: AppDeps = {
    ...base,
    reconciler: createApiReconciler(base),
    close: async () => {
      await cosigner.close();
      await cosignerDb.close();
    },
  };
  const api = await buildApp(deps);
  await api.listen({ host: LOOPBACK, port: apiPort });

  const facilitatorGateway = new EvmChainGateway({
    chainId,
    rpcUrl: env.rpcUrl,
    contracts,
    relayer: privateKeyToAccount(env.facilitatorRelayerKey),
  });
  const facilitatorDb = await createSqlClient(undefined);
  await migrate(facilitatorDb, loadMigrations(MIGRATIONS_DIR));
  const facilitatorService = new Facilitator({
    db: facilitatorDb,
    gateway: facilitatorGateway,
    receipts: evmReceipts(facilitatorGateway),
    screening: new FacilitatorScreening(config.screening.denylist),
    clock,
    relayer: privateKeyToAccount(env.facilitatorRelayerKey),
    options: { chain: CHAINS["base-sepolia"], asset: getAsset(chainId, "USDC"), payeeMode: "any" },
  });
  const facilitator = await buildFacilitatorApp({
    facilitator: facilitatorService,
    disableRequestLogging: logLevel === "warn",
    rateLimits: false,
  });
  await facilitator.listen({ host: LOOPBACK, port: facilitatorPort });

  const indexerDb = await createSqlClient(undefined);
  await migrateIndexer(indexerDb);
  const transport = new HttpReconcilerTransport({ baseUrl: apiUrl, secret: internalSecret });
  const indexer = new Indexer({
    chain: apiGateway,
    transport,
    store: new IndexerStore(indexerDb, chainId),
    windowBlocks: CHAINS["base-sepolia"].reconciliationWindowBlocks,
    clock,
    watchlistRefreshMs: 5_000,
  });

  const funder = privateKeyToAccount(env.funderKey);
  const walletClient = createWalletClient({ account: funder, transport: http(env.rpcUrl) });
  const publicClient = createPublicClient({ transport: http(env.rpcUrl) });

  let timer: ReturnType<typeof setInterval> | null = null;
  let stepInFlight: Promise<void> | null = null;
  const step = async (): Promise<void> => {
    await indexer.tick();
    for (const job of JOBS) {
      try {
        await runJob(deps, job);
      } catch {
        /* runJob logs */
      }
    }
  };
  const runStep = (): Promise<void> => {
    if (stepInFlight) return stepInFlight;
    stepInFlight = step()
      .catch((error) => logger.error({ err: error }, "base-sepolia driver step failed"))
      .finally(() => {
        stepInFlight = null;
      });
    return stepInFlight;
  };
  const intervalMs = options.driverIntervalMs ?? 2_000;
  timer = setInterval(() => void runStep(), intervalMs);
  timer.unref();

  const reconciler = deps.reconciler as unknown as Reconciler;
  const balanceOf = (address: string): Promise<bigint> =>
    apiGateway.getTokenBalance(usdc, getAddress(address));

  return {
    chainName: "base-sepolia",
    canTimeTravel: false,
    sim: undefined as never, // no in-memory chain on Base Sepolia
    clock,
    config,
    deps,
    reconciler,
    ledger,
    cosigner,
    api,
    facilitator,
    indexer,
    apiUrl,
    facilitatorUrl,
    chainId,
    logger,
    async pump() {
      await runStep();
    },
    async pauseDriver() {
      if (timer) clearInterval(timer);
      timer = null;
      await stepInFlight?.catch(() => undefined);
    },
    resumeDriver() {
      if (timer) return;
      timer = setInterval(() => void runStep(), intervalMs);
      timer.unref();
    },
    balanceOf,
    async fund(address: string, minor: bigint) {
      const hash = await walletClient.writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "transfer",
        args: [getAddress(address), minor],
        chain: null,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    },
    async expectedOnChain() {
      const list = await reconciler.watchlist();
      const addresses = list.addresses.map((a) => a.address);
      const expected = await reconciler.expectedBalances({ chain_id: chainId, addresses });
      const byAddress = new Map(expected.balances.map((b) => [b.address.toLowerCase(), BigInt(b.expected)]));
      const rows = [];
      for (const address of addresses) {
        rows.push({
          address,
          onchain: await balanceOf(address),
          expected: byAddress.get(address.toLowerCase()) ?? 0n,
        });
      }
      return rows;
    },
    async stopStack() {
      if (timer) clearInterval(timer);
      await stepInFlight?.catch(() => undefined);
      await indexer.stop().catch(() => undefined);
      await api.close().catch(() => undefined);
      await facilitator.close().catch(() => undefined);
      await deps.close?.().catch(() => undefined);
      await db.close().catch(() => undefined);
      await facilitatorDb.close().catch(() => undefined);
      await indexerDb.close().catch(() => undefined);
    },
  };
}
