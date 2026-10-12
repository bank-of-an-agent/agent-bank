import { KMSClient } from "@aws-sdk/client-kms";
import { KmsSigner } from "./kms";
import { LocalSigner } from "./local";
import type { CosignerSigner, SignerKind } from "./types";

export { DerError, normalizeLowS, parseDerSignature, parseSecp256k1Spki, SECP256K1_N } from "./der";
export { derSignatureToEthereum, KmsSigner, type KmsClientLike, type KmsSignerOptions } from "./kms";
export { LocalSigner, type LocalSignerOptions } from "./local";
export type { CosignerSigner, SignerKind } from "./types";

export interface SignerConfig {
  kind: SignerKind;
  chainId: number;
  nodeEnv: string | undefined;
  privateKey?: string | undefined;
  kmsKeyId?: string | undefined;
  awsRegion?: string | undefined;
  kmsEndpoint?: string | undefined;
}

/** Build the configured signer. KMS calls time out quickly so the co-signer fails closed, not slow. */
export async function createSigner(config: SignerConfig): Promise<CosignerSigner> {
  if (config.kind === "local") {
    if (!config.privateKey) {
      throw new Error("COSIGNER_SIGNER=local needs COSIGNER_PRIVATE_KEY (testnet/development only)");
    }
    return LocalSigner.create({
      privateKey: config.privateKey,
      chainId: config.chainId,
      nodeEnv: config.nodeEnv,
    });
  }
  if (!config.kmsKeyId) throw new Error("COSIGNER_SIGNER=kms needs COSIGNER_KMS_KEY_ID");
  const client = new KMSClient({
    ...(config.awsRegion ? { region: config.awsRegion } : {}),
    ...(config.kmsEndpoint ? { endpoint: config.kmsEndpoint } : {}),
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1_000, requestTimeout: 2_000 },
  });
  return KmsSigner.create({ client, keyId: config.kmsKeyId });
}
