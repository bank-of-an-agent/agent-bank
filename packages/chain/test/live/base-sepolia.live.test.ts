import { describe, expect, it } from "vitest";
import { getAddress, keccak256, toHex, zeroAddress, type Address } from "viem";
import { hashDomain } from "viem";
import { toSafeSmartAccount } from "permissionless/accounts";
import {
  accountSaltNonce,
  encodeOwnableValidatorConfig,
  erc20Abi,
  EVENT_TOPICS,
  EvmChainGateway,
  MODULE_REGISTRY,
  predictAccountAddress,
  RHINESTONE_ATTESTER,
  safeAbi,
  safe7579Abi,
  safeProxyFactoryAbi,
  SAFE_PROXY_CREATION_CODE,
  SESSION_MODULES_BETA,
  SESSION_MODULES_V1,
} from "../../src";
import { cosigner, owner, stranger } from "../helpers";

/**
 * Read-only checks against Base Sepolia (`RUN_LIVE_TESTS=1`, `BASE_SEPOLIA_RPC_URL` optional). Nothing
 * is signed or broadcast.
 */
const RUN = process.env.RUN_LIVE_TESTS === "1";
const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";

describe.skipIf(!RUN)("live: Base Sepolia (read-only)", () => {
  const gateway = new EvmChainGateway({ chainId: 84532, rpcUrl: RPC });
  const client = gateway.publicClient;
  const c = gateway.contracts;

  it("the embedded SafeProxyFactory creation code matches the chain", async () => {
    const code = await client.readContract({
      address: c.safeProxyFactory,
      abi: safeProxyFactoryAbi,
      functionName: "proxyCreationCode",
    });
    expect(code).toBe(SAFE_PROXY_CREATION_CODE);
  });

  it("predicts the same counterfactual address as permissionless", async () => {
    const deployment = { owner: owner.address, cosigner: cosigner.address, salt: 1n };
    const reference = await toSafeSmartAccount({
      client,
      owners: [owner],
      version: "1.4.1",
      entryPoint: { address: c.entryPoint, version: "0.7" },
      safe4337ModuleAddress: c.safe7579,
      erc7579LaunchpadAddress: c.safe7579Launchpad,
      safeSingletonAddress: c.safeSingleton,
      attesters: [RHINESTONE_ATTESTER],
      attestersThreshold: 1,
      validators: [
        { address: c.ownableValidator, context: encodeOwnableValidatorConfig(1, [owner.address]) },
        { address: c.smartSessions, context: "0x" },
      ],
      saltNonce: accountSaltNonce(deployment),
    });
    const predicted = await gateway.predictAccountAddress(deployment);
    expect(await reference.getAddress()).toBe(predicted);
    expect(predicted).toBe(predictAccountAddress(deployment, c));
    expect(await gateway.isDeployed(predicted)).toBe(false);
  });

  it("the account stack and both Smart Sessions module sets are deployed", async () => {
    const addresses: Address[] = [
      c.entryPoint,
      c.safeSingleton,
      c.safeProxyFactory,
      c.safe7579,
      c.safe7579Launchpad,
      MODULE_REGISTRY,
      ...[SESSION_MODULES_V1, SESSION_MODULES_BETA].flatMap((m) => [
        m.smartSessions,
        m.ownableValidator,
        ...Object.values(m.policies),
      ]),
    ];
    for (const address of addresses) expect(await gateway.isDeployed(address), address).toBe(true);
    expect(
      await client.readContract({ address: c.safe7579, abi: safe7579Abi, functionName: "accountId" }),
    ).toBe("rhinestone.safe7579.v1.0.0");
    expect(
      await client.readContract({ address: c.safeSingleton, abi: safeAbi, functionName: "VERSION" }),
    ).toBe("1.4.1");
    const registry = await client.readContract({
      address: c.safe7579Launchpad,
      abi: [
        {
          type: "function",
          name: "REGISTRY",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "address" }],
        },
      ] as const,
      functionName: "REGISTRY",
    });
    expect(registry).toBe(MODULE_REGISTRY);
  });

  it("Smart Sessions emits the session events the indexer decodes", async () => {
    for (const address of [SESSION_MODULES_V1.smartSessions, SESSION_MODULES_BETA.smartSessions]) {
      const code = (await client.getCode({ address }))?.toLowerCase() ?? "";
      expect(code).toContain(`7f${EVENT_TOPICS.SessionCreated.slice(2)}`);
      expect(code).toContain(`7f${EVENT_TOPICS.SessionRemoved.slice(2)}`);
    }
  });

  it("USDC is FiatToken with the EIP-712 domain x402 uses", async () => {
    const read = <F extends "name" | "version" | "decimals" | "DOMAIN_SEPARATOR">(functionName: F) =>
      client.readContract({ address: c.usdc, abi: erc20Abi, functionName });
    expect(await read("name")).toBe("USDC");
    expect(await read("version")).toBe("2");
    expect(Number(await read("decimals"))).toBe(6);
    expect(await read("DOMAIN_SEPARATOR")).toBe(
      hashDomain({
        domain: { name: "USDC", version: "2", chainId: 84532n, verifyingContract: c.usdc },
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
        },
      }),
    );
    const fresh = getAddress(keccak256(toHex(`fresh-${Date.now()}`)).slice(0, 42));
    expect(await gateway.authorizationState(c.usdc, fresh, keccak256(toHex(Date.now())))).toBe(false);
    expect(await gateway.getTokenBalance(c.usdc, fresh)).toBe(0n);
  });

  it("block tags are ordered and linked", async () => {
    const latest = await gateway.getBlock("latest");
    const safe = await gateway.getBlock("safe");
    const finalized = await gateway.getBlock("finalized");
    expect(finalized.number <= safe.number && safe.number <= latest.number).toBe(true);
    expect((await gateway.getBlock(latest.number - 1n)).hash).toBe(latest.parentHash);
  });

  it("queries and normalizes USDC transfers, filtering by party on the node", async () => {
    const latest = (await gateway.getBlock("latest")).number;
    const logs = await gateway.getLogs({ fromBlock: latest - 300n, toBlock: latest, events: ["Transfer"] });
    for (const log of logs) {
      expect(log.address).toBe(getAddress(c.usdc));
      expect(Object.values(log.args).every((v) => typeof v === "string")).toBe(true);
    }
    const sample = logs.find((l) => l.args.from !== zeroAddress);
    if (!sample) return; // a quiet window; nothing more to check
    const party = sample.args.from as Address;
    const filtered = await gateway.getLogs({
      fromBlock: sample.blockNumber,
      toBlock: sample.blockNumber,
      events: ["Transfer"],
      involving: [party],
    });
    expect(filtered.some((l) => l.txHash === sample.txHash && l.logIndex === sample.logIndex)).toBe(true);
    expect(filtered.every((l) => l.args.from === party || l.args.to === party)).toBe(true);
  });

  it("verifies EOA signatures through the universal validator", async () => {
    const hash = keccak256(toHex("agent bank"));
    expect(
      await gateway.verifySignature({ address: owner.address, hash, signature: await owner.sign({ hash }) }),
    ).toBe(true);
    expect(
      await gateway.verifySignature({
        address: owner.address,
        hash,
        signature: await stranger.sign({ hash }),
      }),
    ).toBe(false);
  });
});
