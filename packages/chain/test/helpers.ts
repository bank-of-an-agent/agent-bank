import { type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  encodeOwnerSignature,
  encodeSessionSignature,
  sessionInstallCalls,
  sessionPermissionId,
  sessionSalt,
  signOperationHash,
  type ChainGateway,
  type OnchainSessionScope,
  type PreparedOperation,
  type SessionGrant,
} from "../src";
import type { SimulatedChain } from "../src/simulated";

/** Anvil's well-known development keys (public test keys, never used outside local chains). */
export const DEV_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
];

export const owner = privateKeyToAccount(DEV_KEYS[0] as Hex);
export const cosigner = privateKeyToAccount(DEV_KEYS[1] as Hex);
export const sessionKey = privateKeyToAccount(DEV_KEYS[2] as Hex);
export const payee = privateKeyToAccount(DEV_KEYS[3] as Hex).address;
export const stranger = privateKeyToAccount(DEV_KEYS[4] as Hex);
export const revenue = privateKeyToAccount(DEV_KEYS[5] as Hex).address;
export const otherPayee = privateKeyToAccount(DEV_KEYS[6] as Hex).address;

export const USDC = (n: number | bigint): bigint => BigInt(n) * 1_000_000n;

/** Sign a prepared operation as the owner and submit it. */
export async function submitAsOwner(
  gateway: ChainGateway,
  op: PreparedOperation,
  signer: LocalAccount = owner,
) {
  const signature = encodeOwnerSignature(await signOperationHash(signer, op.userOpHash));
  return gateway.submitOperation({ op, signature });
}

/** Sign a prepared session operation with the session key and the co-signer, then submit it. */
export async function submitAsSession(
  gateway: ChainGateway,
  op: PreparedOperation,
  signers: { session?: LocalAccount; cosigner?: LocalAccount } = {},
) {
  const sessionSignature = await signOperationHash(signers.session ?? sessionKey, op.userOpHash);
  const cosignerSignature = await signOperationHash(signers.cosigner ?? cosigner, op.userOpHash);
  return gateway.submitOperation({
    op,
    signature: encodeSessionSignature({
      permissionId: op.permissionId as Hex,
      sessionSignature,
      cosignerSignature,
    }),
  });
}

/** A default scope for tests. */
export function scope(
  chain: SimulatedChain,
  overrides: Partial<OnchainSessionScope> = {},
): OnchainSessionScope {
  const now = chain.nowSeconds();
  return {
    token: chain.contracts.usdc,
    maxPerTx: USDC(25),
    maxPerDay: USDC(100),
    allowedRecipients: [],
    allowedContracts: [],
    issuedAt: now,
    expiresAt: now + 24 * 3600,
    ...overrides,
  };
}

/** Create, fund, deploy an account and install a session in one owner operation. */
export async function setupAgent(
  chain: SimulatedChain,
  options: { salt?: bigint; fund?: bigint; scope?: Partial<OnchainSessionScope>; sessionId?: string } = {},
): Promise<{ account: Address; grant: SessionGrant; permissionId: Hex }> {
  const gateway = chain.gateway;
  const deployment = { owner: owner.address, cosigner: cosigner.address, salt: options.salt ?? 1n };
  const account = await gateway.predictAccountAddress(deployment);
  if (options.fund !== 0n) chain.faucet(account, options.fund ?? USDC(1000));
  const grant: SessionGrant = {
    sessionKey: sessionKey.address,
    cosigner: cosigner.address,
    salt: sessionSalt(options.sessionId ?? "ses_test"),
    scope: scope(chain, options.scope),
  };
  const op = await gateway.prepareOwnerOperation({
    account,
    deployment,
    calls: sessionInstallCalls({ contracts: gateway.contracts, grant }),
  });
  const { userOpHash } = await submitAsOwner(gateway, op);
  const receipt = await gateway.getOperationReceipt(userOpHash);
  if (receipt.status !== "succeeded")
    throw new Error(`setup failed: ${receipt.status} ${receipt.revertReason}`);
  return { account, grant, permissionId: sessionPermissionId(grant, gateway.contracts) };
}
