import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  anvilForkContracts,
  EvmChainGateway,
  SESSION_MODULES_BETA,
  SESSION_MODULES_V1,
  type AgentBankDeploymentFile,
  type ChainContracts,
} from "../../src";

/** `SESSION_MODULES=beta` runs the fork suites against the pre-V1 Smart Sessions deployment. */
export const sessionModules =
  process.env.SESSION_MODULES === "beta" ? SESSION_MODULES_BETA : SESSION_MODULES_V1;

/**
 * Local fork environment for the end-to-end tests: an Anvil fork of Base Sepolia (chain id 31337)
 * and a local Alto bundler. If `ANVIL_RPC_URL` / `BUNDLER_URL` answer, they are reused; otherwise
 * the processes are started with `ANVIL_CMD` (default `nix shell nixpkgs#foundry -c anvil`) and
 * `ALTO_CMD` (default `npx -y @pimlico/alto@0.0.21`). Only Anvil's public development keys and
 * freshly generated keys are used.
 */

export const ANVIL_RPC_URL = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8645";
export const BUNDLER_URL = process.env.BUNDLER_URL ?? "http://127.0.0.1:4437/rpc";
const FORK_URL = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";

/** Anvil development keys 8 and 9 run the bundler (executor, utility). */
const EXECUTOR_KEY = "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97";
const UTILITY_KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";

const children: ChildProcess[] = [];

async function answers(url: string, method: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    const body = (await res.json()) as { result?: unknown };
    return body.result !== undefined;
  } catch {
    return false;
  }
}

async function waitFor(url: string, method: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await answers(url, method)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${url} did not answer ${method} within ${timeoutMs} ms`);
}

function start(command: string, args: string[]): void {
  const [bin, ...rest] = command.split(" ");
  const child = spawn(bin as string, [...rest, ...args], { stdio: "ignore", detached: false });
  children.push(child);
}

/** Start (or reuse) Anvil and Alto. */
export async function startForkEnv(): Promise<void> {
  if (!(await answers(ANVIL_RPC_URL, "eth_chainId"))) {
    const port = new URL(ANVIL_RPC_URL).port || "8545";
    start(process.env.ANVIL_CMD ?? "nix shell nixpkgs#foundry -c anvil", [
      "--fork-url",
      FORK_URL,
      "--chain-id",
      "31337",
      "--port",
      port,
      "--host",
      "127.0.0.1",
    ]);
    await waitFor(ANVIL_RPC_URL, "eth_chainId", 600_000);
  }
  if (!(await answers(BUNDLER_URL, "eth_supportedEntryPoints"))) {
    const port = new URL(BUNDLER_URL).port || "4337";
    start(process.env.ALTO_CMD ?? "npx -y @pimlico/alto@0.0.21", [
      "--entrypoints",
      "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
      "--executor-private-keys",
      EXECUTOR_KEY,
      "--utility-private-key",
      UTILITY_KEY,
      "--rpc-url",
      ANVIL_RPC_URL,
      "--safe-mode",
      "false",
      "--port",
      port,
      "--log-level",
      "warn",
    ]);
    await waitFor(BUNDLER_URL, "eth_supportedEntryPoints", 600_000);
  }
}

export function stopForkEnv(): void {
  for (const child of children) child.kill("SIGTERM");
}

const anvilClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(ANVIL_RPC_URL) });

/** Public client on the fork. */
export const forkClient: PublicClient = createPublicClient({
  chain: foundry,
  transport: http(ANVIL_RPC_URL),
});

/** A gateway on the fork (no paymaster: accounts pay gas with ETH set through Anvil). */
export function forkGateway(contracts: ChainContracts = anvilForkContracts(sessionModules)): EvmChainGateway {
  return new EvmChainGateway({
    chainId: 31337,
    rpcUrl: ANVIL_RPC_URL,
    bundlerUrl: BUNDLER_URL,
    sponsor: false,
    contracts,
    relayer: privateKeyToAccount(UTILITY_KEY),
  });
}

const fiatTokenAbi = parseAbi([
  "function masterMinter() view returns (address)",
  "function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
]);

/** Mint real Base Sepolia USDC on the fork through FiatToken's own minter path. */
export async function mintUsdc(usdc: Address, to: Address, amount: bigint): Promise<void> {
  const masterMinter = await forkClient.readContract({
    address: usdc,
    abi: fiatTokenAbi,
    functionName: "masterMinter",
  });
  const minter: Address = "0x000000000000000000000000000000000000bEEF";
  for (const who of [masterMinter, minter]) {
    await anvilClient.impersonateAccount({ address: who });
    await anvilClient.setBalance({ address: who, value: parseEther("10") });
  }
  const wallet = createWalletClient({ chain: foundry, transport: http(ANVIL_RPC_URL) });
  const configure = await wallet.writeContract({
    account: masterMinter,
    address: usdc,
    abi: fiatTokenAbi,
    functionName: "configureMinter",
    args: [minter, 2n ** 255n],
  });
  await forkClient.waitForTransactionReceipt({ hash: configure });
  const mint = await wallet.writeContract({
    account: minter,
    address: usdc,
    abi: fiatTokenAbi,
    functionName: "mint",
    args: [to, amount],
  });
  await forkClient.waitForTransactionReceipt({ hash: mint });
  for (const who of [masterMinter, minter]) await anvilClient.stopImpersonatingAccount({ address: who });
}

/** Anvil development key 7 deploys the Agent Bank contracts on the fork. */
const DEPLOYER_KEY = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356";

/**
 * Make sure the Agent Bank contracts are deployed on the fork, at the deterministic CREATE2 addresses
 * of the contracts repository's `deployments/31337.dry-run.json` (synced into `src/abis/deployments`).
 * If they are missing, the contracts repository (`CONTRACTS_DIR`, default the sibling checkout) is
 * copied to a temporary directory and its `script/Deploy.s.sol` is broadcast to the fork with `forge`
 * (`FORGE_CMD`, default `nix shell nixpkgs#foundry -c forge`). The repository itself is never written.
 */
export async function ensureAgentBankContracts(): Promise<AgentBankDeploymentFile> {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = JSON.parse(
    readFileSync(join(here, "../../src/abis/deployments/31337.dry-run.json"), "utf8"),
  ) as AgentBankDeploymentFile;
  const hook = file.contracts.AgentPolicyHook as Address;
  const code = await forkClient.getCode({ address: hook });
  if (code && code !== "0x") return file;
  const source = process.env.CONTRACTS_DIR ?? join(here, "../../../../../contracts");
  const work = mkdtempSync(join(tmpdir(), "agentbank-contracts-"));
  cpSync(source, work, {
    recursive: true,
    filter: (src) => !/[/\\](out|cache|broadcast|\.git)([/\\]|$)/.test(src.slice(source.length)),
  });
  const [bin, ...args] = (process.env.FORGE_CMD ?? "nix shell nixpkgs#foundry -c forge").split(" ");
  execFileSync(
    bin as string,
    [
      ...args,
      "script",
      "script/Deploy.s.sol",
      "--rpc-url",
      ANVIL_RPC_URL,
      "--broadcast",
      "--private-key",
      DEPLOYER_KEY,
    ],
    { cwd: work, stdio: "ignore", timeout: 900_000 },
  );
  const deployed = await forkClient.getCode({ address: hook });
  if (!deployed || deployed === "0x")
    throw new Error("Agent Bank contracts are still missing after deployment");
  return file;
}

/** Advance the fork's clock and mine a block. */
export async function increaseTime(seconds: number): Promise<void> {
  await anvilClient.increaseTime({ seconds });
  await anvilClient.mine({ blocks: 1 });
}

/** Send a plain transaction from the bundler's utility key (an Anvil development key) and wait for it. */
export async function sendFromRelayer(to: Address, data: Hex): Promise<"success" | "reverted"> {
  const wallet = createWalletClient({
    account: privateKeyToAccount(UTILITY_KEY),
    chain: foundry,
    transport: http(ANVIL_RPC_URL),
  });
  const hash = await wallet.sendTransaction({ to, data });
  return (await forkClient.waitForTransactionReceipt({ hash })).status;
}

/** Give an address ETH for gas. */
export async function fundEth(address: Address, eth = "1"): Promise<void> {
  await anvilClient.setBalance({ address, value: parseEther(eth) });
}

/** Poll a user operation until it is no longer pending. */
export async function waitForOperation(gateway: EvmChainGateway, userOpHash: Hex, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await gateway.getOperationReceipt(userOpHash);
    if (receipt.status !== "pending" && receipt.status !== "not_found") return receipt;
    if (Date.now() > deadline) return receipt;
    await new Promise((r) => setTimeout(r, 500));
  }
}
