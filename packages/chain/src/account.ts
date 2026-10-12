import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  launchpadInitHashParams,
  ownableValidatorConfigParams,
  safe7579LaunchpadAbi,
  safeProxyFactoryAbi,
} from "./abis";
import { SAFE_PROXY_CREATION_CODE } from "./constants";
import type { AccountDeployment, ChainContracts } from "./types";

/**
 * Agent Bank smart accounts: Safe v1.4.1 + Safe7579 adapter, deployed counterfactually through the
 * Safe7579 launchpad.
 *
 * Layout (part of the address, so it never changes for a deployed configuration):
 * - Safe owners `[owner]`, threshold 1: the owner's exit path is Safe's native `execTransaction`.
 * - Validators: OwnableValidator `{threshold: 1, owners: [owner]}` (owner operations, EIP-191 over
 *   the user operation hash) and Smart Sessions (no sessions; they are enabled by owner operations).
 * - No executors, fallbacks or hooks at deployment: Agent Bank's own modules (AgentPolicyHook,
 *   TopUpExecutor) are not registry-attested and are installed by owner operations after
 *   `setRegistry(0)` (see `calls.ts`).
 * - ERC-7484 attesters from `contracts.attesters` (the launchpad's registry rejects an empty list).
 * - CREATE2 salt nonce: `uint256(keccak256(abi.encode(cosigner, salt)))`, so the address commits to
 *   the Agent Bank co-signer the account was opened with.
 */

/** Sorted, de-duplicated, checksummed addresses (numeric order, as Solidity's `address` comparison). */
export function sortAddresses(addresses: readonly Address[]): Address[] {
  const unique = [...new Set(addresses.map((a) => getAddress(a)))];
  return unique.sort((a, b) => {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** `abi.encode(uint256 threshold, address[] owners)` with owners sorted, as OwnableValidator requires. */
export function encodeOwnableValidatorConfig(threshold: number, owners: readonly Address[]): Hex {
  const sorted = sortAddresses(owners);
  if (sorted.length !== owners.length) throw new RangeError("OwnableValidator owners must be unique");
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > sorted.length) {
    throw new RangeError("OwnableValidator threshold must be between 1 and the number of owners");
  }
  return encodeAbiParameters(ownableValidatorConfigParams, [BigInt(threshold), sorted]);
}

/** The CREATE2 salt nonce passed to `SafeProxyFactory.createProxyWithNonce`. */
export function accountSaltNonce(deployment: Pick<AccountDeployment, "cosigner" | "salt">): bigint {
  if (deployment.salt < 0n || deployment.salt >= 2n ** 256n) throw new RangeError("salt must be a uint256");
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [getAddress(deployment.cosigner), deployment.salt],
      ),
    ),
  );
}

/** The launchpad `InitData` (without `callData`) for an account. */
export function accountInitData(deployment: AccountDeployment, contracts: ChainContracts) {
  const owner = getAddress(deployment.owner);
  return {
    singleton: contracts.safeSingleton,
    owners: [owner] as readonly Address[],
    threshold: 1n,
    setupTo: contracts.safe7579Launchpad,
    setupData: encodeFunctionData({
      abi: safe7579LaunchpadAbi,
      functionName: "initSafe7579",
      args: [
        contracts.safe7579,
        [],
        [],
        [],
        sortAddresses(contracts.attesters),
        contracts.attestersThreshold,
      ],
    }),
    safe7579: contracts.safe7579,
    validators: [
      { module: contracts.ownableValidator, initData: encodeOwnableValidatorConfig(1, [owner]) },
      { module: contracts.smartSessions, initData: "0x" as Hex },
    ] as readonly { module: Address; initData: Hex }[],
  };
}

/** The launchpad `InitData` of an account (without `callData`). */
export type AccountInitData = ReturnType<typeof accountInitData>;

/** `Safe7579Launchpad.hash(InitData)`: what `preValidationSetup` stores and `validateUserOp` checks. */
export function accountInitHash(init: AccountInitData): Hex {
  return keccak256(
    encodeAbiParameters(launchpadInitHashParams, [
      init.singleton,
      init.owners,
      init.threshold,
      init.setupTo,
      init.setupData,
      init.safe7579,
      init.validators,
    ]),
  );
}

/** The Safe proxy initializer: `launchpad.preValidationSetup(initHash, address(0), "")`. */
export function accountInitializer(deployment: AccountDeployment, contracts: ChainContracts): Hex {
  return encodeFunctionData({
    abi: safe7579LaunchpadAbi,
    functionName: "preValidationSetup",
    args: [accountInitHash(accountInitData(deployment, contracts)), zeroAddress, "0x"],
  });
}

/** ERC-4337 `factory` / `factoryData` that deploy the account. */
export function accountFactoryArgs(
  deployment: AccountDeployment,
  contracts: ChainContracts,
): { factory: Address; factoryData: Hex } {
  return {
    factory: contracts.safeProxyFactory,
    factoryData: encodeFunctionData({
      abi: safeProxyFactoryAbi,
      functionName: "createProxyWithNonce",
      args: [
        contracts.safe7579Launchpad,
        accountInitializer(deployment, contracts),
        accountSaltNonce(deployment),
      ],
    }),
  };
}

/**
 * Counterfactual account address. Pure: identical to what `SafeProxyFactory.createProxyWithNonce`
 * deploys, without any network access.
 */
export function predictAccountAddress(deployment: AccountDeployment, contracts: ChainContracts): Address {
  const initializer = accountInitializer(deployment, contracts);
  const salt = keccak256(
    encodePacked(["bytes32", "uint256"], [keccak256(initializer), accountSaltNonce(deployment)]),
  );
  const bytecode = concatHex([
    SAFE_PROXY_CREATION_CODE,
    toHex(BigInt(contracts.safe7579Launchpad), { size: 32 }),
  ]);
  return getContractAddress({ from: contracts.safeProxyFactory, salt, bytecode, opcode: "CREATE2" });
}

/**
 * Calldata of the deploying user operation: `launchpad.setupSafe(initData ‖ callData)`, where
 * `executeCallData` is the account's first `execute(...)`. The deploying operation must not revert
 * during execution: the launchpad initialises validators in the validation phase, so a reverted
 * setup leaves the proxy un-initialisable.
 */
export function wrapSetupSafe(
  deployment: AccountDeployment,
  contracts: ChainContracts,
  executeCallData: Hex,
): Hex {
  const init = accountInitData(deployment, contracts);
  return encodeFunctionData({
    abi: safe7579LaunchpadAbi,
    functionName: "setupSafe",
    args: [{ ...init, callData: executeCallData }],
  });
}
