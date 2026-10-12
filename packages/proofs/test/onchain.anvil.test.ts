import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToBytes,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromBytes32, onchainScopeId, scopeField, toBytes32 } from "../src/field";
import {
  CLAIMS_VERIFIER_ABI,
  toClaimsVerifierArgs,
  type ClaimsVerifierArgs,
  type U64x13,
} from "../src/onchain";
import { prove } from "../src/prover";
import { canPayPerTx, createProofRequest, verifiedCompany, type ProofRequest } from "../src/request";
import { releaseProverResources, type ProofPresentation } from "../src/verifier";
import { AGENT_SECRET, buildFixture, CHAIN_ID } from "./fixtures";

/**
 * Opt-in (`RUN_ANVIL_TESTS=1`): deploys the contracts repository's compiled
 * `AgentAttestationRegistry`, `AgentClaimsGroth16Verifier` and `AgentClaimsVerifier` on a fresh
 * Anvil, publishes the test tree's root, and checks that an SDK proof for
 * `onchainScopeId(chainId, consumer, context)` passes `verify` and `verifyAndConsume` with the
 * calldata of `toClaimsVerifierArgs`.
 *
 * - Contracts: `CONTRACTS_DIR/out` (default the sibling `contracts` checkout). Without `out/`, the
 *   repository is copied to a temporary directory and built there with `FORGE_CMD`; the
 *   repository itself is never written.
 * - Anvil: `ANVIL_RPC_URL` when it answers, otherwise `ANVIL_CMD` on a free local port (default
 *   `anvil` from a pinned nixpkgs foundry).
 */

const RUN = process.env.RUN_ANVIL_TESTS === "1";
const FOUNDRY = "nix shell github:NixOS/nixpkgs/6510408d147d8c5e6d76043e899e9251756f6a75#foundry -c";

/** Anvil's public development keys 0 (deployer, attester) and 1 (the consuming "contract"). */
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const CONSUMER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const STRANGER = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const CONTEXT = keccak256(stringToBytes("agentbank.proofs.anvil-test.context"));

const children: ChildProcess[] = [];

function contractsOut(): string {
  const source =
    process.env.CONTRACTS_DIR ?? fileURLToPath(new URL("../../../../contracts", import.meta.url));
  const out = join(source, "out");
  if (existsSync(join(out, "AgentClaimsVerifier.sol/AgentClaimsVerifier.json"))) return out;
  if (!existsSync(join(source, "foundry.toml"))) {
    throw new Error(`no contracts repository at ${source} (set CONTRACTS_DIR)`);
  }
  const work = mkdtempSync(join(tmpdir(), "agentbank-contracts-"));
  cpSync(source, work, {
    recursive: true,
    filter: (src) => !/[/\\](out|cache|broadcast|\.git)([/\\]|$)/.test(src.slice(source.length)),
  });
  const [bin, ...args] = (process.env.FORGE_CMD ?? `${FOUNDRY} forge`).split(" ");
  execFileSync(bin as string, [...args, "build"], { cwd: work, stdio: "ignore", timeout: 900_000 });
  return join(work, "out");
}

function artifact(out: string, name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(join(out, `${name}.sol`, `${name}.json`), "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    return ((await res.json()) as { result?: unknown }).result !== undefined;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function startAnvil(): Promise<string> {
  const reuse = process.env.ANVIL_RPC_URL;
  if (reuse && (await answers(reuse))) return reuse;
  const port = await freePort();
  const [bin, ...args] = (process.env.ANVIL_CMD ?? `${FOUNDRY} anvil`).split(" ");
  const child = spawn(bin as string, [...args, "--port", String(port), "--host", "127.0.0.1"], {
    stdio: "ignore",
  });
  children.push(child);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 600_000;
  while (!(await answers(url))) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`anvil did not start on ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return url;
}

function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}

describe.skipIf(!RUN)("AgentClaimsVerifier on Anvil accepts SDK proofs for on-chain scope ids", () => {
  let rpcUrl: string;
  let client: PublicClient;
  let verifier: Address;
  let chainId: number;
  let scopeId: string;
  let request: ProofRequest;
  let presentation: ProofPresentation;
  let args: ClaimsVerifierArgs;
  const fixture = buildFixture();

  beforeAll(async () => {
    const out = contractsOut();
    rpcUrl = await startAnvil();
    client = createPublicClient({ chain: foundry, transport: http(rpcUrl), pollingInterval: 100 });
    const wallet = createWalletClient({ account: DEPLOYER, chain: foundry, transport: http(rpcUrl) });
    const deploy = async (name: string, constructorArgs: readonly unknown[]): Promise<Address> => {
      const { abi, bytecode } = artifact(out, name);
      const hash = await wallet.deployContract({ abi, bytecode, args: constructorArgs });
      const receipt = await client.waitForTransactionReceipt({ hash });
      return receipt.contractAddress as Address;
    };
    const registry = await deploy("AgentAttestationRegistry", [DEPLOYER.address, DEPLOYER.address]);
    const groth16 = await deploy("AgentClaimsGroth16Verifier", []);
    verifier = await deploy("AgentClaimsVerifier", [registry, groth16]);

    const now = Number((await client.getBlock()).timestamp);
    const publish = await wallet.writeContract({
      address: registry,
      abi: artifact(out, "AgentAttestationRegistry").abi,
      functionName: "publishRoot",
      args: [toBytes32(fixture.tree.root), 1n, BigInt(now - 60), BigInt(now + 3_600), fixture.tree.size],
    });
    expect((await client.waitForTransactionReceipt({ hash: publish })).status).toBe("success");

    chainId = await client.getChainId();
    scopeId = onchainScopeId(chainId, CONSUMER.address, CONTEXT);
    // The witness's root is published on CHAIN_ID; the consumer lives on Anvil's chain.
    request = createProofRequest({
      scope: scopeId,
      require: [verifiedCompany(), canPayPerTx("5.00")],
      chainId: CHAIN_ID,
      now,
    });
    presentation = await prove({ secret: AGENT_SECRET, witness: fixture.baseWitness, request });
    args = toClaimsVerifierArgs(request, presentation);
  }, 900_000);

  afterAll(async () => {
    for (const child of children) child.kill("SIGTERM");
    await releaseProverResources();
  });

  it("derives the request's scope exactly as scopeOf(consumer, context)", async () => {
    const onchain = await client.readContract({
      address: verifier,
      abi: CLAIMS_VERIFIER_ABI,
      functionName: "scopeOf",
      args: [CONSUMER.address, CONTEXT],
    });
    expect(onchain).toBe(scopeField(scopeId));
    expect(args.claims.scope).toBe(onchain);
  });

  it("verifies the calldata of toClaimsVerifierArgs (eth_call)", async () => {
    const verify = (claims: ClaimsVerifierArgs["claims"], minAnonymitySet: number, maxRootAge: bigint) =>
      client.readContract({
        address: verifier,
        abi: CLAIMS_VERIFIER_ABI,
        functionName: "verify",
        args: [claims, args.proof, minAnonymitySet, maxRootAge],
      });
    expect(await verify(args.claims, 16, 0n)).toBe(true);
    expect(await verify(args.claims, fixture.tree.size, 3_600n)).toBe(true);
    expect(await verify(args.claims, fixture.tree.size + 1, 0n)).toBe(false);
    expect(await verify({ ...args.claims, nonce: args.claims.nonce + 1n }, 16, 0n)).toBe(false);
    const looser = [...args.claims.mins];
    looser[1] = 0n; // per_tx_limit >= 0 instead of >= 5 USDC: another statement
    expect(await verify({ ...args.claims, mins: looser as unknown as U64x13 }, 16, 0n)).toBe(false);
  });

  it("admits the agent once through verifyAndConsume from the consumer", async () => {
    const call = (account: typeof CONSUMER) =>
      client.simulateContract({
        account,
        address: verifier,
        abi: CLAIMS_VERIFIER_ABI,
        functionName: "verifyAndConsume",
        args: [CONTEXT, args.claims, args.proof, 16, 0n],
      });
    const simulated = await call(CONSUMER);
    expect(simulated.result).toBe(fromBytes32(presentation.nullifier));
    expect(revertName(await call(STRANGER).catch((e: unknown) => e))).toBe("ScopeMismatch");

    const wallet = createWalletClient({ account: CONSUMER, chain: foundry, transport: http(rpcUrl) });
    const hash = await wallet.writeContract(simulated.request);
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");
    expect(
      await client.readContract({
        address: verifier,
        abi: CLAIMS_VERIFIER_ABI,
        functionName: "nonceUsed",
        args: [args.claims.scope, args.claims.nonce],
      }),
    ).toBe(true);
    expect(revertName(await call(CONSUMER).catch((e: unknown) => e))).toBe("NonceAlreadyUsed");
  });
});
