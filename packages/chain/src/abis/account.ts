/**
 * Minimal ABIs of the account stack: Safe v1.4.1, SafeProxyFactory, the Safe7579 adapter and its
 * launchpad. Signatures match the deployed contracts listed in `constants.ts`.
 */

const moduleInit = {
  type: "tuple[]",
  components: [
    { name: "module", type: "address" },
    { name: "initData", type: "bytes" },
  ],
} as const;

/** Safe7579 adapter (called on the account; the adapter is the Safe's fallback handler). */
export const safe7579Abi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "mode", type: "bytes32" },
      { name: "executionCalldata", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeFromExecutor",
    stateMutability: "payable",
    inputs: [
      { name: "mode", type: "bytes32" },
      { name: "executionCalldata", type: "bytes" },
    ],
    outputs: [{ name: "returnData", type: "bytes[]" }],
  },
  {
    type: "function",
    name: "installModule",
    stateMutability: "payable",
    inputs: [
      { name: "moduleTypeId", type: "uint256" },
      { name: "module", type: "address" },
      { name: "initData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "uninstallModule",
    stateMutability: "payable",
    inputs: [
      { name: "moduleTypeId", type: "uint256" },
      { name: "module", type: "address" },
      { name: "deInitData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "isModuleInstalled",
    stateMutability: "view",
    inputs: [
      { name: "moduleTypeId", type: "uint256" },
      { name: "module", type: "address" },
      { name: "additionalContext", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "setRegistry",
    stateMutability: "nonpayable",
    inputs: [
      { name: "registry", type: "address" },
      { name: "attesters", type: "address[]" },
      { name: "threshold", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "accountId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "event",
    name: "ModuleInstalled",
    inputs: [
      { name: "moduleTypeId", type: "uint256", indexed: false },
      { name: "module", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ModuleUninstalled",
    inputs: [
      { name: "moduleTypeId", type: "uint256", indexed: false },
      { name: "module", type: "address", indexed: false },
    ],
  },
] as const;

/** Safe7579Launchpad: counterfactual deployment of a Safe with ERC-7579 modules. */
export const safe7579LaunchpadAbi = [
  {
    type: "function",
    name: "preValidationSetup",
    stateMutability: "nonpayable",
    inputs: [
      { name: "initHash", type: "bytes32" },
      { name: "to", type: "address" },
      { name: "preInit", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setupSafe",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "initData",
        type: "tuple",
        components: [
          { name: "singleton", type: "address" },
          { name: "owners", type: "address[]" },
          { name: "threshold", type: "uint256" },
          { name: "setupTo", type: "address" },
          { name: "setupData", type: "bytes" },
          { name: "safe7579", type: "address" },
          { name: "validators", ...moduleInit },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "initSafe7579",
    stateMutability: "nonpayable",
    inputs: [
      { name: "safe7579", type: "address" },
      { name: "executors", ...moduleInit },
      { name: "fallbacks", ...moduleInit },
      { name: "hooks", ...moduleInit },
      { name: "attesters", type: "address[]" },
      { name: "threshold", type: "uint8" },
    ],
    outputs: [],
  },
] as const;

/** Parameters hashed into the launchpad's `initHash` (everything in `setupSafe` except `callData`). */
export const launchpadInitHashParams = [
  { name: "singleton", type: "address" },
  { name: "owners", type: "address[]" },
  { name: "threshold", type: "uint256" },
  { name: "setupTo", type: "address" },
  { name: "setupData", type: "bytes" },
  { name: "safe7579", type: "address" },
  { name: "validators", ...moduleInit },
] as const;

/** SafeProxyFactory v1.4.1. */
export const safeProxyFactoryAbi = [
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
  {
    type: "function",
    name: "proxyCreationCode",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

/** Safe v1.4.1 (subset used by the owner exit path and by tests). */
export const safeAbi = [
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "nonce",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "VERSION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "swapOwner",
    stateMutability: "nonpayable",
    inputs: [
      { name: "prevOwner", type: "address" },
      { name: "oldOwner", type: "address" },
      { name: "newOwner", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "isOwner",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isModuleEnabled",
    stateMutability: "view",
    inputs: [{ name: "module", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getTransactionHash",
    stateMutability: "view",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "_nonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    type: "event",
    name: "AddedOwner",
    inputs: [{ name: "owner", type: "address", indexed: true }],
  },
  {
    type: "event",
    name: "RemovedOwner",
    inputs: [{ name: "owner", type: "address", indexed: true }],
  },
  {
    type: "event",
    name: "ExecutionSuccess",
    inputs: [
      { name: "txHash", type: "bytes32", indexed: true },
      { name: "payment", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ExecutionFailure",
    inputs: [
      { name: "txHash", type: "bytes32", indexed: true },
      { name: "payment", type: "uint256", indexed: false },
    ],
  },
] as const;

/** EIP-712 types of a Safe transaction (`execTransaction`), domain `{ chainId, verifyingContract: safe }`. */
export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** ERC-7579 module type ids. */
export const MODULE_TYPE = { validator: 1n, executor: 2n, fallback: 3n, hook: 4n } as const;
