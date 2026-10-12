/** `AgentPolicyHook` (contracts/src/AgentPolicyHook.sol): configuration types, views and events. */

const policyConfigComponents = [
  {
    name: "tokenLimits",
    type: "tuple[]",
    components: [
      { name: "token", type: "address" },
      { name: "maxPerTx", type: "uint128" },
      { name: "maxPerDay", type: "uint128" },
    ],
  },
  { name: "allowedRecipients", type: "address[]" },
  {
    name: "allowedContracts",
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "kind", type: "uint8" },
    ],
  },
  { name: "recipientAllowlistEnabled", type: "bool" },
] as const;

/** ABI parameter of `abi.encode(PolicyConfig)` (the hook's `onInstall` data). */
export const policyConfigParams = [
  { name: "config", type: "tuple", components: policyConfigComponents },
] as const;

/** `AgentPolicyHook`: configuration (owner-native path only), views and events. */
export const agentPolicyHookAbi = [
  {
    type: "function",
    name: "applyConfig",
    stateMutability: "nonpayable",
    inputs: [{ name: "config", type: "tuple", components: policyConfigComponents }],
    outputs: [],
  },
  {
    type: "function",
    name: "setTokenLimit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "maxPerTx", type: "uint128" },
      { name: "maxPerDay", type: "uint128" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setRecipient",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setRecipientAllowlistEnabled",
    stateMutability: "nonpayable",
    inputs: [{ name: "enabled", type: "bool" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setContract",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "kind", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "isInitialized",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "tokenLimit",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [
      { name: "maxPerTx", type: "uint128" },
      { name: "maxPerDay", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "spentToday",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "remainingToday",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "contractKind",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "target", type: "address" },
    ],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "isRecipientAllowed",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "SpendRecorded",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "spentToday", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PolicyInstalled",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "epoch", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PolicyUninstalled",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "epoch", type: "uint64", indexed: false },
    ],
  },
] as const;

/** `IAgentPolicyHook.ContractKind`. */
export const CONTRACT_KIND = {
  None: 0,
  Generic: 1,
  AgentEscrow: 2,
  PaymentStreams: 3,
  TimeLockVaults: 4,
} as const;

/** Name of an `IAgentPolicyHook.ContractKind`. */
export type ContractKindName = keyof typeof CONTRACT_KIND;
