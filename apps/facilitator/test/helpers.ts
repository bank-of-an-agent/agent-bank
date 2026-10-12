import {
  approveCall,
  encodeOwnerSignature,
  signOperationHash,
  type AccountDeployment,
  type ChainGateway,
} from "@agentbank/chain";
import { SimulatedChain } from "@agentbank/chain/simulated";
import { CHAINS, getAsset, ManualClock, unixSeconds, usdc, type AssetInfo } from "@agentbank/core";
import type { RequestInputOf } from "@agentbank/core/api";
import type { SqlClient } from "@agentbank/db";
import {
  concat,
  encodeAbiParameters,
  getAddress,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { ContractSignatureVerifier } from "../src/erc1271";
import { Facilitator, type FacilitatorOptions } from "../src/facilitator";
import { Metrics } from "../src/metrics";
import { simulatedReceipts } from "../src/receipts";
import { SandboxScreening, type ScreeningProvider } from "../src/screening";
import { authorizationTypedData, ERC6492_MAGIC_SUFFIX, type ExactAuthorization } from "../src/verification";

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

/** The buyer agent's spend key (ADR 0001: an EOA). */
export const payer = privateKeyToAccount(DEV_KEYS[0] as Hex);
/** The seller's account address (x402 payTo). */
export const seller: Address = privateKeyToAccount(DEV_KEYS[1] as Hex).address;
export const otherSeller: Address = privateKeyToAccount(DEV_KEYS[2] as Hex).address;
export const stranger = privateKeyToAccount(DEV_KEYS[3] as Hex);
/** The facilitator's testnet relayer. */
export const relayer = privateKeyToAccount(DEV_KEYS[4] as Hex);
/** Another relayer (a different facilitator, or a front-runner). */
export const otherRelayer = privateKeyToAccount(DEV_KEYS[5] as Hex);
/** Owner key of a contract (Safe7579) wallet. */
export const walletOwner = privateKeyToAccount(DEV_KEYS[6] as Hex);
export const walletCosigner = privateKeyToAccount(DEV_KEYS[7] as Hex);

/** The sandbox screening denylist's sanctioned address. */
export const SANCTIONED: Address = getAddress("0x000000000000000000000000000000000000bad1");

export const START = "2026-10-11T12:00:00.000Z";
export { usdc };

export function randomNonce(): Hex {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export interface Harness {
  clock: ManualClock;
  chain: SimulatedChain;
  db: SqlClient;
  facilitator: Facilitator;
  metrics: Metrics;
  emf: string[];
  asset: AssetInfo;
  network: string;
  nowSeconds(): bigint;
}

export interface HarnessOptions {
  options?: Partial<FacilitatorOptions>;
  /** ERC-1271 verifier for payers with code (default: the simulator's). */
  contractSignatures?: ContractSignatureVerifier;
  screening?: ScreeningProvider;
  automine?: boolean;
  /** Wrap the simulator's gateway (fault injection, front-running). */
  gateway?: (gateway: ChainGateway, chain: SimulatedChain) => ChainGateway;
  clock?: ManualClock;
}

/** A facilitator over a fresh SimulatedChain (shared manual clock) and the given database. */
export function createHarness(db: SqlClient, overrides: HarnessOptions = {}): Harness {
  const clock = overrides.clock ?? new ManualClock(START);
  const chain = new SimulatedChain({ clock, automine: overrides.automine ?? true });
  const emf: string[] = [];
  const metrics = new Metrics({ emfNamespace: "AgentBank/Facilitator", emfSink: (line) => emf.push(line) });
  const asset = getAsset(chain.chainId, "USDC");
  const gateway = overrides.gateway ? overrides.gateway(chain.gateway, chain) : chain.gateway;
  const facilitator = new Facilitator({
    db,
    gateway,
    receipts: simulatedReceipts(chain),
    screening: overrides.screening ?? new SandboxScreening(),
    clock,
    relayer,
    metrics,
    ...(overrides.contractSignatures ? { contractSignatures: overrides.contractSignatures } : {}),
    options: { chain: CHAINS.simulated, asset, receiptTimeoutMs: 2_000, ...overrides.options },
  });
  return {
    clock,
    chain,
    db,
    facilitator,
    metrics,
    emf,
    asset,
    network: CHAINS.simulated.caip2,
    nowSeconds: () => BigInt(unixSeconds(clock.now())),
  };
}

/** Override some gateway methods, delegating everything else to the real gateway. */
export function overrideGateway(gateway: ChainGateway, overrides: Partial<ChainGateway>): ChainGateway {
  return new Proxy(gateway, {
    get(target, prop, receiver) {
      if (Object.hasOwn(overrides, prop)) return (overrides as Record<PropertyKey, unknown>)[prop];
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export type FacilitatorBody = RequestInputOf<"x402Verify">["body"];

export interface PaymentSpec {
  /** Signer of the authorization (default the payer). */
  signer?: LocalAccount;
  /** `authorization.from` (default the signer's address). */
  from?: Address;
  payTo?: Address;
  /** `authorization.to` (default payTo). */
  to?: Address;
  amount?: bigint;
  /** `authorization.value` (default amount). */
  value?: bigint;
  validAfter?: bigint;
  validBefore?: bigint;
  nonce?: Hex;
  network?: string;
  asset?: Address;
  scheme?: string;
  maxTimeoutSeconds?: number;
  /** Replace the signature (contract wallets, malformed signatures). */
  signature?: Hex | ((authorization: ExactAuthorization) => Promise<Hex> | Hex);
  /** Sign under another EIP-712 domain. */
  domain?: AssetInfo;
}

export interface BuiltPayment {
  body: FacilitatorBody;
  authorization: ExactAuthorization;
  signature: Hex;
}

/** An x402 v2 verify/settle body with an EIP-3009 authorization signed by `spec.signer`. */
/** What `buildPayment` needs: the facilitator's clock, asset and network. */
export type PaymentContext = Pick<Harness, "nowSeconds" | "asset" | "network">;

export async function buildPayment(h: PaymentContext, spec: PaymentSpec = {}): Promise<BuiltPayment> {
  const now = h.nowSeconds();
  const signer = spec.signer ?? payer;
  const amount = spec.amount ?? usdc("0.01");
  const requirements = {
    scheme: spec.scheme ?? "exact",
    network: spec.network ?? h.network,
    asset: spec.asset ?? h.asset.address,
    amount: amount.toString(),
    payTo: spec.payTo ?? seller,
    maxTimeoutSeconds: spec.maxTimeoutSeconds ?? 60,
    extra: { name: "USDC", version: "2" },
  };
  const authorization: ExactAuthorization = {
    from: spec.from ?? signer.address,
    to: spec.to ?? requirements.payTo,
    value: spec.value ?? amount,
    validAfter: spec.validAfter ?? now - 600n,
    validBefore: spec.validBefore ?? now + 60n,
    nonce: spec.nonce ?? randomNonce(),
  };
  const signature =
    typeof spec.signature === "function"
      ? await spec.signature(authorization)
      : (spec.signature ??
        (await signer.signTypedData(authorizationTypedData(spec.domain ?? h.asset, authorization))));
  return {
    authorization,
    signature,
    body: {
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        resource: { url: "https://seller.example/weather", description: "Weather report" },
        accepted: { ...requirements },
        payload: {
          signature,
          authorization: {
            from: authorization.from,
            to: authorization.to,
            value: authorization.value.toString(),
            validAfter: authorization.validAfter.toString(),
            validBefore: authorization.validBefore.toString(),
            nonce: authorization.nonce,
          },
        },
      },
      paymentRequirements: requirements,
    },
  };
}

/** Deep-copy a body and edit it (tests that tamper with one field). */
export function tamper(body: FacilitatorBody, edit: (copy: FacilitatorBody) => void): FacilitatorBody {
  const copy = structuredClone(body);
  edit(copy);
  return copy;
}

/** Deploy a Safe7579 contract wallet in the simulator (owner path) and fund it. */
export async function deployContractWallet(
  chain: SimulatedChain,
  options: { salt?: bigint; fund?: bigint } = {},
): Promise<Address> {
  const gateway = chain.gateway;
  const deployment: AccountDeployment = {
    owner: walletOwner.address,
    cosigner: walletCosigner.address,
    salt: options.salt ?? 7n,
  };
  const account = await gateway.predictAccountAddress(deployment);
  if (options.fund !== 0n) chain.faucet(account, options.fund ?? usdc("50"));
  const op = await gateway.prepareOwnerOperation({
    account,
    deployment,
    calls: [approveCall({ token: chain.contracts.usdc, spender: seller, amount: 0n })],
  });
  const { userOpHash } = await gateway.submitOperation({
    op,
    signature: encodeOwnerSignature(await signOperationHash(walletOwner, op.userOpHash)),
  });
  const receipt = await gateway.getOperationReceipt(userOpHash);
  if (receipt.status !== "succeeded") throw new Error(`wallet deployment failed: ${receipt.revertReason}`);
  return account;
}

/** ERC-1271 signature of the wallet: OwnableValidator address ‖ owner's ECDSA over the digest. */
export async function contractWalletSignature(
  chain: SimulatedChain,
  digest: Hex,
  owner: PrivateKeyAccount = walletOwner,
): Promise<Hex> {
  return concat([chain.contracts.ownableValidator, await owner.sign({ hash: digest })]);
}

/** ERC-6492 wrapper (factory, factoryData, inner signature) ‖ magic suffix. */
export function erc6492Wrap(factory: Address, factoryData: Hex, inner: Hex): Hex {
  return concat([
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes" }, { type: "bytes" }],
      [factory, factoryData, inner],
    ),
    `0x${ERC6492_MAGIC_SUFFIX}`,
  ]);
}
