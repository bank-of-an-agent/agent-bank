import { CHAINS, getAsset } from "@agentbank/core";
import { getAddress, type Address, type Hex } from "viem";
import type { ChainContracts } from "./types";

/**
 * Deployed infrastructure addresses (identical on Base Sepolia and on an Anvil fork of it) and the
 * address sets each gateway starts from. Every address below was checked for code on Base Sepolia.
 */

/** ERC-4337 EntryPoint v0.7. */
export const ENTRY_POINT_V07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
/** Safe v1.4.1 singleton (non-L2). */
export const SAFE_SINGLETON_V141: Address = "0x41675C099F32341bf84BFc5382aF534df5C7461a";
/** SafeL2 v1.4.1 singleton: emits per-transaction events, recommended on L2s; Agent Bank's default. */
export const SAFE_L2_SINGLETON_V141: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
/** SafeProxyFactory v1.4.1. */
export const SAFE_PROXY_FACTORY_V141: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
/** Safe7579 adapter v1.0.0 (`accountId()` = "rhinestone.safe7579.v1.0.0"). */
export const SAFE7579_ADAPTER: Address = "0x7579EE8307284F293B1927136486880611F20002";
/** Safe7579 launchpad (counterfactual deployment with modules). Its immutable `REGISTRY` is {@link MODULE_REGISTRY}. */
export const SAFE7579_LAUNCHPAD: Address = "0x7579011aB74c46090561ea277Ba79D510c6C00ff";
/** Rhinestone ERC-7484 module registry. */
export const MODULE_REGISTRY: Address = "0x000000000069E2a187AEFFb852bF3cCdC95151B2";
/** Rhinestone's registry attester. */
export const RHINESTONE_ATTESTER: Address = "0x000000333034E9f539ce08819E12c1b8Cb29084d";

/**
 * `SafeProxyFactory.proxyCreationCode()` of v1.4.1 (keccak256
 * 0x1856e0ee08399d74e0ea0b03adca210aeade6f748969ac023cdcb4dd62dcaf5f), embedded so account
 * addresses can be predicted offline. A live test checks it against the chain.
 */
export const SAFE_PROXY_CREATION_CODE: Hex =
  "0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564";

/** A Smart Sessions deployment with the OwnableValidator and policies of the same release. */
export interface SessionModuleSet {
  smartSessions: Address;
  ownableValidator: Address;
  policies: ChainContracts["policies"];
}

/**
 * Rhinestone module **V1** release (what `@rhinestone/module-sdk` 0.3+ targets: changelog 0.3.0
 * "V1 contract addresses"). Agent Bank's default.
 */
export const SESSION_MODULES_V1: SessionModuleSet = {
  smartSessions: "0x00000000008bDABA73cD9815d79069c247Eb4bDA",
  ownableValidator: "0x000000000013fdB5234E4E3162a810F54d9f7E98",
  policies: {
    timeFrame: "0x0000000000D30f611fA3bf652ac6879428586930",
    spendingLimits: "0x000000000033212e272655d8a22402db819477a6",
    universalAction: "0x0000000000714Cf48FcF88A0bFBa70d313415032",
    sudo: "0x0000000000FEEc8D74e3143fBaBbca515358d869",
  },
};

/**
 * The pre-V1 (beta) deployment that `@rhinestone/module-sdk` 0.2.x targeted, including Smart
 * Sessions `0x00000000002B0eCfbD0496EE71e01257dA0E37DE`. Same ABI as V1, but **not usable for Agent
 * Bank sessions**: this release checks the ERC-7484 registry (`checkForAccount`) for the session
 * validator and policies when a session is enabled, and they are not attested for Agent Bank
 * accounts, so `enableSessions` reverts (`NoTrustedAttestersFound()` / missing attestations; verified
 * on an Anvil fork of Base Sepolia). Kept for reference only. Never mix modules of different releases.
 */
export const SESSION_MODULES_BETA: SessionModuleSet = {
  smartSessions: "0x00000000002B0eCfbD0496EE71e01257dA0E37DE",
  ownableValidator: "0x2483DA3A338895199E5e538530213157e931Bf06",
  policies: {
    timeFrame: "0x8177451511dE0577b911C254E9551D981C26dc72",
    spendingLimits: "0x00000088D48cF102A8Cdb0137A9b173f957c6343",
    universalAction: "0x0000006DDA6c463511C4e9B05CFc34C1247fCF1F",
    sudo: "0x0000003111cD8e92337C100F22B7A9dbf8DEE301",
  },
};

/** Account-stack addresses shared by Base Sepolia and Anvil forks of it. */
function accountStack(modules: SessionModuleSet) {
  return {
    entryPoint: ENTRY_POINT_V07,
    safeSingleton: SAFE_L2_SINGLETON_V141,
    safeProxyFactory: SAFE_PROXY_FACTORY_V141,
    safe7579: SAFE7579_ADAPTER,
    safe7579Launchpad: SAFE7579_LAUNCHPAD,
    smartSessions: modules.smartSessions,
    ownableValidator: modules.ownableValidator,
    attesters: [RHINESTONE_ATTESTER],
    attestersThreshold: 1,
    policies: { ...modules.policies },
  } satisfies Omit<ChainContracts, "usdc">;
}

/**
 * Base Sepolia (84532). Agent Bank's own contracts (escrow, streams, vaults, hook, executors) are not
 * deployed yet: pass their addresses through {@link withAgentBankContracts} once they are.
 */
export function baseSepoliaContracts(modules: SessionModuleSet = SESSION_MODULES_V1): ChainContracts {
  return { ...accountStack(modules), usdc: getAsset(CHAINS["base-sepolia"].id, "USDC").address };
}

/** Anvil fork of Base Sepolia (31337): same infrastructure; USDC is real USDC unless overridden (MockUSDC). */
export function anvilForkContracts(modules: SessionModuleSet = SESSION_MODULES_V1): ChainContracts {
  return { ...accountStack(modules), usdc: getAsset(CHAINS["base-sepolia"].id, "USDC").address };
}

/** Agent Bank contract addresses (deployment output of the contracts repository). */
export type AgentBankContractAddresses = Pick<
  ChainContracts,
  "escrow" | "streams" | "vaults" | "policyHook" | "topUpExecutor" | "sweepExecutor"
>;

/** Return `contracts` with Agent Bank's deployed contract addresses filled in (checksummed). */
export function withAgentBankContracts(
  contracts: ChainContracts,
  deployed: AgentBankContractAddresses,
): ChainContracts {
  const out: ChainContracts = { ...contracts, policies: { ...contracts.policies } };
  for (const key of [
    "escrow",
    "streams",
    "vaults",
    "policyHook",
    "topUpExecutor",
    "sweepExecutor",
  ] as const) {
    const value = deployed[key];
    if (value !== undefined) out[key] = getAddress(value);
  }
  return out;
}

/** Shape of the contracts repository's `deployments/<chainId>[.dry-run].json` (copied by `scripts/sync-abis.sh`). */
export interface AgentBankDeploymentFile {
  chainId: number;
  contracts: Partial<
    Record<
      | "AgentEscrow"
      | "AgentPolicyHook"
      | "PaymentStreams"
      | "SweepExecutor"
      | "TimeLockVaults"
      | "TopUpExecutor",
      string
    >
  >;
  dependencies?: Partial<Record<"USDC" | "ERC8004ValidationRegistry" | "MockTreasuryFund", string>>;
  /** `broadcast` (deployed) or `dry-run` (predicted CREATE2 addresses only). */
  mode?: string;
}

/**
 * `base` with the Agent Bank addresses of a deployment file. On Anvil the file's USDC is MockUSDC;
 * pass `useDeploymentUsdc: false` to keep `base.usdc` (e.g. real USDC on a Base Sepolia fork).
 */
export function contractsFromDeployment(
  base: ChainContracts,
  file: AgentBankDeploymentFile,
  options: { useDeploymentUsdc?: boolean } = {},
): ChainContracts {
  const c = file.contracts;
  const deployed: AgentBankContractAddresses = {};
  if (c.AgentEscrow) deployed.escrow = getAddress(c.AgentEscrow);
  if (c.PaymentStreams) deployed.streams = getAddress(c.PaymentStreams);
  if (c.TimeLockVaults) deployed.vaults = getAddress(c.TimeLockVaults);
  if (c.AgentPolicyHook) deployed.policyHook = getAddress(c.AgentPolicyHook);
  if (c.TopUpExecutor) deployed.topUpExecutor = getAddress(c.TopUpExecutor);
  if (c.SweepExecutor) deployed.sweepExecutor = getAddress(c.SweepExecutor);
  const out = withAgentBankContracts(base, deployed);
  const usdc = file.dependencies?.USDC;
  if (usdc && (options.useDeploymentUsdc ?? true)) out.usdc = getAddress(usdc);
  return out;
}

/** Addresses the in-memory {@link SimulatedChain} uses (any address works; these read well in tests). */
export const SIMULATED_CONTRACTS: ChainContracts = {
  ...accountStack(SESSION_MODULES_V1),
  usdc: getAsset(CHAINS.simulated.id, "USDC").address,
  escrow: getAddress("0x000000000000000000000000000000000000ab01"),
  streams: getAddress("0x000000000000000000000000000000000000ab02"),
  vaults: getAddress("0x000000000000000000000000000000000000ab03"),
  policyHook: getAddress("0x000000000000000000000000000000000000ab04"),
  topUpExecutor: getAddress("0x000000000000000000000000000000000000ab05"),
};

/** Default signing deadlines (seconds) for prepared operations. */
export const DEFAULT_SESSION_OP_TTL_SECONDS = 10 * 60;
/** Default signing deadline of owner operations (15 minutes, the owner-authorization window). */
export const DEFAULT_OWNER_OP_TTL_SECONDS = 15 * 60;
