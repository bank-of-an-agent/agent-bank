/** `TimeLockVaults` (contracts/src/TimeLockVaults.sol): functions and events Agent Bank uses. */
export const timeLockVaultsAbi = [
  {
    type: "function",
    name: "createVault",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "unlockAt", type: "uint64" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawWithSignature",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setOwner",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "newOwner", type: "address" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getVault",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "account", type: "address" },
          { name: "unlockAt", type: "uint64" },
          { name: "owner", type: "address" },
          { name: "nonce", type: "uint96" },
          { name: "token", type: "address" },
          { name: "balance", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "vaultAccount",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "vaultCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalHeld",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "earlyWithdrawalDigest",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "event",
    name: "VaultCreated",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "unlockAt", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "from", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "newBalance", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "early", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OwnerChanged",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
  },
] as const;

/** EIP-712 domain name/version of `TimeLockVaults`. */
export const TIME_LOCK_VAULTS_EIP712 = { name: "AgentBank TimeLockVaults", version: "1" } as const;

/** EIP-712 types the vault owner signs for an early withdrawal. */
export const EARLY_WITHDRAWAL_TYPES = {
  EarlyWithdrawal: [
    { name: "vaultId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** `TimeLockVaults.MAX_LOCK_DURATION` (3650 days). */
export const VAULT_MAX_LOCK_SECONDS = 3650n * 24n * 3600n;
