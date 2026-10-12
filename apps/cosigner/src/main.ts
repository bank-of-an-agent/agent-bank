import { systemClock } from "@agentbank/core";
import { buildApp } from "./app";
import { createOperationCodec } from "./chain";
import { loadConfig } from "./config";
import { migrateCosigner, openCosignerDatabase } from "./database";
import { Metrics } from "./metrics";
import { CosignerService, type Logger } from "./service";
import { createSigner } from "./signer";

/**
 * Co-signer server (port 8081). Fails fast on bad configuration; at runtime
 * it fails closed: any error refuses the request.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = await openCosignerDatabase(config.databaseUrl);
  await migrateCosigner(db);
  const signer = await createSigner({
    kind: config.signer.kind,
    chainId: config.chain.id,
    nodeEnv: config.nodeEnv,
    privateKey: config.signer.privateKey,
    kmsKeyId: config.signer.kmsKeyId,
    awsRegion: config.signer.awsRegion,
    kmsEndpoint: config.signer.kmsEndpoint,
  });
  const chain = createOperationCodec(config);
  const metrics = new Metrics({ emfNamespace: config.metricsNamespace });
  // The service is built before the app whose logger it uses.
  const log: { current?: Logger } = {};
  const service = new CosignerService({
    db,
    signer,
    chain,
    clock: systemClock,
    metrics,
    logger: { warn: (o, m) => log.current?.warn(o, m), error: (o, m) => log.current?.error(o, m) },
    config: {
      chainId: config.chain.id,
      revenueAddress: config.revenueAddress,
      maxFeeSweep: config.maxFeeSweep,
      failClosed: config.failClosed,
      ownerAuthorizationChainId: config.ownerAuthorizationChainId,
    },
  });
  metrics.gauge(
    "cosigner_fail_closed",
    "1 when COSIGNER_FAIL_CLOSED is set and every decision is refused",
    () => (config.failClosed ? 1 : 0),
  );
  const app = buildApp({
    service,
    sharedSecret: config.sharedSecret,
    metrics,
    logger: { level: config.logLevel, redact: ["req.headers.authorization"] },
  });
  log.current = app.log;

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await db.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      cosigner_address: signer.address,
      signer: signer.kind,
      chain: config.chain.name,
      chain_id: config.chain.id,
      fail_closed: config.failClosed,
    },
    "co-signer listening",
  );
  if (config.failClosed)
    app.log.warn(
      "COSIGNER_FAIL_CLOSED=true: every evaluation, co-signature and x402 authorization is refused",
    );
}

main().catch((error: unknown) => {
  console.error("co-signer failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
