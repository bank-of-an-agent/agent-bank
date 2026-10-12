import { baseSepoliaContracts, erc20Abi, EvmChainGateway, type ChainGateway } from "@agentbank/chain";
import { CHAINS, getAsset, ManualClock, systemClock, unixSeconds, usdc } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  stringToHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc1271ViaCall } from "../src/erc1271";
import { Facilitator } from "../src/facilitator";
import { evmReceipts, simulatedReceipts } from "../src/receipts";
import { SandboxScreening } from "../src/screening";
import { authorizationDigest, recoverEcdsaSigner, type ExactAuthorization } from "../src/verification";
import { buildPayment, payer, relayer, seller, START, type PaymentContext } from "./helpers";

/**
 * The real Base Sepolia USDC domain: name "USDC", version "2", chainId 84532,
 * verifyingContract 0x036CbD53842c5426634e7929541eC2318f3dCF7e (FiatToken v2.2). The digest is
 * re-derived by hand from the EIP-712 definition, the signature is produced with viem's
 * `signTypedData` exactly as a buyer's wallet would, and a facilitator configured for Base
 * Sepolia verifies it (chain reads stubbed; `RUN_LIVE_TESTS=1` reads the real chain).
 */

const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
/** `TRANSFER_WITH_AUTHORIZATION_TYPEHASH` in FiatToken's EIP3009.sol. */
const FIAT_TOKEN_TYPEHASH: Hex = "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267";

const asset = getAsset(CHAINS["base-sepolia"].id, "USDC");

function manualDigest(a: ExactAuthorization): Hex {
  const domainTypehash = keccak256(
    stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  );
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        domainTypehash,
        keccak256(stringToHex("USDC")),
        keccak256(stringToHex("2")),
        84532n,
        BASE_SEPOLIA_USDC,
      ],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [FIAT_TOKEN_TYPEHASH, a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce],
    ),
  );
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
}

describe("EIP-3009 on the real Base Sepolia USDC domain", () => {
  it("the registry holds Base Sepolia USDC with FiatToken's EIP-712 domain", () => {
    expect(asset).toMatchObject({
      address: BASE_SEPOLIA_USDC,
      chainId: 84532,
      decimals: 6,
      eip712: { name: "USDC", version: "2" },
    });
    expect(
      keccak256(
        stringToHex(
          "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
        ),
      ),
    ).toBe(FIAT_TOKEN_TYPEHASH);
  });

  it("a viem signTypedData signature over the real domain verifies against the hand-derived digest", async () => {
    const authorization: ExactAuthorization = {
      from: payer.address,
      to: seller,
      value: 1_500_000n,
      validAfter: 0n,
      validBefore: 1_791_720_060n,
      nonce: keccak256(stringToHex("agentbank.facilitator.test-vector.1")),
    };
    const signature = await payer.signTypedData({
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: BASE_SEPOLIA_USDC },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: authorization,
    });
    const digest = authorizationDigest(asset, authorization);
    expect(digest).toBe(manualDigest(authorization));
    expect(await recoverEcdsaSigner(digest, signature)).toBe(payer.address);
    // The same authorization signed for the simulator's USDC is a different message.
    const simulated = getAsset(CHAINS.simulated.id, "USDC");
    expect(authorizationDigest(simulated, authorization)).not.toBe(digest);
  });
});

describe("a facilitator serving Base Sepolia (eip155:84532)", () => {
  let db: SqlClient;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  /** Chain reads answered locally: an EOA payer with 1,000 USDC and an unused nonce. */
  function stubGateway(): ChainGateway {
    const implemented: Partial<ChainGateway> = {
      chainId: 84532,
      contracts: baseSepoliaContracts(),
      isDeployed: async () => false,
      authorizationState: async () => false,
      getTokenBalance: async () => usdc("1000"),
      getBlock: async () => ({ number: 1n, hash: zeroHash, parentHash: zeroHash, timestamp: 0 }),
    };
    return new Proxy(implemented as ChainGateway, {
      get(target, prop) {
        if (prop in target) return target[prop as keyof ChainGateway];
        if (prop === "publicClient") return undefined; // no JSON-RPC client: ERC-1271 goes through verifySignature
        throw new Error(`stub gateway: ${String(prop)} is not available`);
      },
    });
  }

  function facilitatorFor(gateway: ChainGateway, clock = new ManualClock(START)) {
    const facilitator = new Facilitator({
      db,
      gateway,
      receipts: simulatedReceipts({ transaction: () => undefined }),
      screening: new SandboxScreening(),
      clock,
      relayer,
      options: { chain: CHAINS["base-sepolia"], asset },
    });
    const context: PaymentContext = {
      asset,
      network: CHAINS["base-sepolia"].caip2,
      nowSeconds: () => BigInt(unixSeconds(clock.now())),
    };
    return { facilitator, context };
  }

  it("verifies a payment signed for the real Base Sepolia USDC domain", async () => {
    const { facilitator, context } = facilitatorFor(stubGateway());
    const { body } = await buildPayment(context, { amount: usdc("0.50") });
    expect(body.paymentRequirements).toMatchObject({ network: "eip155:84532", asset: BASE_SEPOLIA_USDC });
    expect((await facilitator.verify(body)).body).toEqual({ isValid: true, payer: payer.address });
    expect(facilitator.supported().kinds).toEqual([
      expect.objectContaining({
        network: "eip155:84532",
        extra: expect.objectContaining({ asset: BASE_SEPOLIA_USDC }),
      }),
    ]);
  });

  it("refuses a signature made for another chain's domain, and other networks", async () => {
    const { facilitator, context } = facilitatorFor(stubGateway());
    const wrongDomain = await buildPayment(context, { domain: getAsset(CHAINS.simulated.id, "USDC") });
    expect((await facilitator.verify(wrongDomain.body)).body.invalidReason).toBe(
      "invalid_exact_evm_payload_signature",
    );
    const simulatedNetwork = await buildPayment(context, { network: "eip155:1337" });
    expect((await facilitator.verify(simulatedNetwork.body)).body.invalidReason).toBe("invalid_network");
    const mainnet = await buildPayment(context, { network: "eip155:8453" });
    expect((await facilitator.verify(mainnet.body)).body.invalidReason).toBe("invalid_network");
  });

  it("refuses a gateway for another chain or another USDC", () => {
    const wrongChain = { ...stubGateway(), chainId: 1337 } as unknown as ChainGateway;
    expect(() => facilitatorFor(wrongChain)).toThrow(/chain/);
    const wrongToken = {
      chainId: 84532,
      contracts: { ...baseSepoliaContracts(), usdc: seller },
    } as unknown as ChainGateway;
    expect(() => facilitatorFor(wrongToken)).toThrow(/USDC/);
  });
});

/**
 * Opt-in (`RUN_LIVE_TESTS=1`, optional `BASE_SEPOLIA_RPC_URL`): read-only verification against
 * the real Base Sepolia RPC. A fresh key has no USDC, so a correctly signed payment passes the
 * signature, code and nonce checks on the real chain and stops at `insufficient_funds`.
 */
describe.skipIf(!process.env.RUN_LIVE_TESTS)("live Base Sepolia (read-only)", () => {
  let db: SqlClient;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  it("verifies against the real USDC contract", async () => {
    const gateway = new EvmChainGateway({
      chainId: 84532,
      rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
      relayer: privateKeyToAccount(generatePrivateKey()),
    });
    const facilitator = new Facilitator({
      db,
      gateway,
      receipts: evmReceipts(gateway),
      contractSignatures: erc1271ViaCall(gateway.publicClient),
      screening: new SandboxScreening(),
      clock: systemClock,
      options: { chain: CHAINS["base-sepolia"], asset },
    });
    const buyer = privateKeyToAccount(generatePrivateKey());
    const { body } = await buildPayment(
      { asset, network: "eip155:84532", nowSeconds: () => BigInt(unixSeconds(systemClock.now())) },
      { signer: buyer, amount: usdc("0.01") },
    );
    const out = await facilitator.verify(body);
    expect(out.body).toMatchObject({
      isValid: false,
      invalidReason: "insufficient_funds",
      payer: buyer.address,
    });
    expect((await facilitator.health()).checks.chain).toBe("ok");

    // The well-known Anvil development addresses carry EIP-7702 delegations on Base Sepolia (anyone
    // holding the public keys can change them). USDC then verifies with ERC-1271 on the delegate,
    // never ecrecover: the facilitator's verdict on the signature must equal USDC's own, for the
    // owner's signature and for a stranger's, whatever the delegate currently does.
    expect(await gateway.isDeployed(payer.address)).toBe(true);
    const context = {
      asset,
      network: "eip155:84532",
      nowSeconds: () => BigInt(unixSeconds(systemClock.now())),
    };
    const caller = privateKeyToAccount(generatePrivateKey()).address;
    const usdcAccepts = async (a: ExactAuthorization, signature: Hex): Promise<boolean> => {
      try {
        await gateway.publicClient.call({
          account: caller,
          to: asset.address,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transferWithAuthorization",
            args: [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, signature],
          }),
        });
        return true;
      } catch (error) {
        if (/invalid signature/i.test(String((error as { shortMessage?: string }).shortMessage ?? error)))
          return false;
        throw error;
      }
    };
    const signatureFailures = ["payer_has_code", "invalid_exact_evm_payload_signature"];
    for (const signer of [payer, privateKeyToAccount(generatePrivateKey())]) {
      const built = await buildPayment(context, { signer, from: payer.address, amount: 1n });
      const verdict = (await facilitator.verify(built.body)).body;
      const facilitatorAccepts = verdict.isValid || !signatureFailures.includes(verdict.invalidReason ?? "");
      expect(facilitatorAccepts).toBe(await usdcAccepts(built.authorization, built.signature));
      if (signer !== payer) expect(verdict.invalidReason).toBe("payer_has_code");
    }
  });
});
