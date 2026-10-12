import { systemClock, type Clock, type TypedDataVerifier } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import type { Address } from "viem";
import { buildApp } from "./app";
import { InjectCosignerClient } from "./client";
import { migrateCosigner } from "./database";
import { Metrics } from "./metrics";
import type { OperationCodec } from "./operation";
import { CosignerService, type AuditExporter, type Logger } from "./service";
import type { CosignerSigner } from "./signer/types";

export interface CreateCosignerOptions {
  /** The co-signer's own database; migrated here (idempotent). */
  db: SqlClient;
  signer: CosignerSigner;
  /** A `ChainGateway` (e.g. `SimulatedChain`) or any codec with the same hash/decode functions. */
  chain: OperationCodec;
  sharedSecret: string;
  revenueAddress: Address;
  /** Largest sweep of accrued fees per operation, minor units. Default 100 USDC. */
  maxFeeSweep?: bigint;
  failClosed?: boolean;
  /** EIP-712 domain chain id of owner authorizations (default: the chain's id). */
  ownerAuthorizationChainId?: number;
  clock?: Clock;
  ownerVerifier?: TypedDataVerifier;
  auditExporter?: AuditExporter;
  /** CloudWatch EMF namespace for metrics log lines (off by default). */
  metricsNamespace?: string;
  logger?: FastifyServerOptions["logger"];
  serviceLogger?: Logger;
}

export interface Cosigner {
  service: CosignerService;
  app: FastifyInstance;
  /** In-process `CosignerClient` over the app (real HMAC signing, routing and validation). */
  client: InjectCosignerClient;
  metrics: Metrics;
  close(): Promise<void>;
}

/** Assemble a co-signer in-process: migrations, service, HTTP app and an in-process client. */
export async function createCosigner(options: CreateCosignerOptions): Promise<Cosigner> {
  await migrateCosigner(options.db);
  const clock = options.clock ?? systemClock;
  const metrics = new Metrics({ emfNamespace: options.metricsNamespace });
  const service = new CosignerService({
    db: options.db,
    signer: options.signer,
    chain: options.chain,
    clock,
    metrics,
    ...(options.ownerVerifier ? { ownerVerifier: options.ownerVerifier } : {}),
    ...(options.auditExporter ? { auditExporter: options.auditExporter } : {}),
    ...(options.serviceLogger ? { logger: options.serviceLogger } : {}),
    config: {
      chainId: options.chain.chainId,
      revenueAddress: options.revenueAddress,
      maxFeeSweep: options.maxFeeSweep ?? 100_000_000n,
      failClosed: options.failClosed ?? false,
      ownerAuthorizationChainId: options.ownerAuthorizationChainId ?? options.chain.chainId,
    },
  });
  const app = buildApp({
    service,
    sharedSecret: options.sharedSecret,
    clock,
    metrics,
    logger: options.logger ?? false,
  });
  await app.ready();
  return {
    service,
    app,
    client: new InjectCosignerClient(app, options.sharedSecret, clock),
    metrics,
    close: () => app.close(),
  };
}
