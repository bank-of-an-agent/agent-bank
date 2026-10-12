import type { ChainGateway } from "@agentbank/chain";
import type { Clock, CosignerClient } from "@agentbank/core";
import { createSqlClient } from "@agentbank/db";
import { generatePrivateKey } from "viem/accounts";
import type { Config } from "../config";
import type { Logger } from "../logger";

/**
 * `COSIGNER_MODE=inprocess` (local development on the simulated chain or Anvil only; the config
 * refuses it in production): the real co-signer (`createCosigner` from `@agentbank/cosigner`)
 * runs inside the API process with a local testnet key and its own database, reached through
 * its in-process client (HMAC-signed requests, the same routes and validation as over HTTP).
 * The package is loaded on demand, so production bundles never include it.
 */
export async function createInProcessCosigner(
  config: Config,
  chain: ChainGateway,
  clock: Clock,
  logger: Logger,
): Promise<{ client: CosignerClient; address: string; close(): Promise<void> }> {
  const { createCosigner, LocalSigner } = await import("@agentbank/cosigner");
  const privateKey = config.cosigner.devPrivateKey ?? generatePrivateKey();
  if (!config.cosigner.devPrivateKey) {
    logger.warn(
      "COSIGNER_DEV_PRIVATE_KEY is not set: a fresh co-signer key was generated. Account addresses commit to it, so set one when the database outlives this process.",
    );
  }
  const db = await createSqlClient(config.cosigner.databaseUrl);
  const signer = LocalSigner.create({ privateKey, chainId: chain.chainId, nodeEnv: config.env });
  const cosigner = await createCosigner({
    db,
    signer,
    chain,
    sharedSecret: config.cosigner.sharedSecret,
    revenueAddress: config.revenueAddress,
    clock,
  });
  logger.warn({ cosigner: signer.address }, "in-process co-signer (local development only)");
  return {
    client: cosigner.client,
    address: signer.address,
    async close() {
      await cosigner.close();
      await db.close();
    },
  };
}
