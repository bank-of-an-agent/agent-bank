/** `TopUpExecutor` and `SweepExecutor` (contracts/src): keeper entry points, configuration and events. */

const topUpRuleComponents = [
  { name: "token", type: "address" },
  { name: "refillTo", type: "uint128" },
  { name: "whenBelow", type: "uint128" },
  { name: "maxPerDay", type: "uint128" },
] as const;

/** ABI parameter of `abi.encode(RuleInit[])` (the executor's `onInstall` data). */
export const topUpRuleInitParams = [
  {
    name: "rules",
    type: "tuple[]",
    components: [
      { name: "agent", type: "address" },
      { name: "rule", type: "tuple", components: topUpRuleComponents },
    ],
  },
] as const;

/** `TopUpExecutor`: keeper trigger, previews, rules and events. */
export const topUpExecutorAbi = [
  {
    type: "function",
    name: "topUp",
    stateMutability: "nonpayable",
    inputs: [
      { name: "treasury", type: "address" },
      { name: "agent", type: "address" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "previewTopUp",
    stateMutability: "view",
    inputs: [
      { name: "treasury", type: "address" },
      { name: "agent", type: "address" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "setRule",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      { name: "token", type: "address" },
      { name: "refillTo", type: "uint128" },
      { name: "whenBelow", type: "uint128" },
      { name: "maxPerDay", type: "uint128" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "removeRule",
    stateMutability: "nonpayable",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getRule",
    stateMutability: "view",
    inputs: [
      { name: "treasury", type: "address" },
      { name: "agent", type: "address" },
    ],
    outputs: [{ name: "", type: "tuple", components: topUpRuleComponents }],
  },
  {
    type: "function",
    name: "spentToday",
    stateMutability: "view",
    inputs: [
      { name: "treasury", type: "address" },
      { name: "agent", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isInitialized",
    stateMutability: "view",
    inputs: [{ name: "treasury", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "ToppedUp",
    inputs: [
      { name: "treasury", type: "address", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RuleSet",
    inputs: [
      { name: "treasury", type: "address", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "refillTo", type: "uint128", indexed: false },
      { name: "whenBelow", type: "uint128", indexed: false },
      { name: "maxPerDay", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RuleRemoved",
    inputs: [
      { name: "treasury", type: "address", indexed: true },
      { name: "agent", type: "address", indexed: true },
    ],
  },
] as const;

/** `SweepExecutor` (counsel-gated): keeper entry points and events. */
export const sweepExecutorAbi = [
  {
    type: "function",
    name: "sweep",
    stateMutability: "nonpayable",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "assets", type: "uint256" },
      { name: "shares", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "shares", type: "uint256" },
      { name: "assets", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "Swept",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "fund", type: "address", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Redeemed",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "fund", type: "address", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "shares", type: "uint256", indexed: false },
      { name: "assets", type: "uint256", indexed: false },
    ],
  },
] as const;
