/** `AgentEscrow` (contracts/src/AgentEscrow.sol): functions and events Agent Bank uses. */
export const agentEscrowAbi = [
  {
    type: "function",
    name: "lock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "payee", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "expiresAt", type: "uint64" },
      { name: "arbiter", type: "address" },
      { name: "validator", type: "address" },
      { name: "validationRequestHash", type: "bytes32" },
      { name: "validationThreshold", type: "uint8" },
      { name: "termsHash", type: "bytes32" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "releaseByValidation",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "dispute",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "resolve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "payeeAmount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getEscrow",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "payer", type: "address" },
          { name: "expiresAt", type: "uint64" },
          { name: "status", type: "uint8" },
          { name: "validationThreshold", type: "uint8" },
          { name: "payee", type: "address" },
          { name: "createdAt", type: "uint64" },
          { name: "token", type: "address" },
          { name: "arbiter", type: "address" },
          { name: "validator", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "validationRequestHash", type: "bytes32" },
          { name: "termsHash", type: "bytes32" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "escrowCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalLocked",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "refundableAt",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "Locked",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "payee", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "expiresAt", type: "uint64", indexed: false },
      { name: "arbiter", type: "address", indexed: false },
      { name: "termsHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ValidationConfigured",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "validator", type: "address", indexed: true },
      { name: "requestHash", type: "bytes32", indexed: true },
      { name: "threshold", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Released",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "payee", type: "address", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "reason", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "reason", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Disputed",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "disputant", type: "address", indexed: true },
      { name: "refundableAt", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Resolved",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "arbiter", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "payeeAmount", type: "uint256", indexed: false },
      { name: "payerAmount", type: "uint256", indexed: false },
    ],
  },
] as const;

/** `IAgentEscrow.Status`. */
export const ESCROW_STATUS = ["None", "Active", "Disputed", "Released", "Refunded", "Resolved"] as const;
/** `IAgentEscrow.ReleaseReason`. */
export const ESCROW_RELEASE_REASON = ["PayerApproval", "ArbiterDecision", "Validation"] as const;
/** `IAgentEscrow.RefundReason`. */
export const ESCROW_REFUND_REASON = ["PayeeVoluntary", "Expired", "DisputeTimeout"] as const;

/** `AgentEscrow.DISPUTE_TIMEOUT` (30 days). */
export const ESCROW_DISPUTE_TIMEOUT_SECONDS = 30n * 24n * 3600n;
/** `AgentEscrow.MAX_ESCROW_DURATION` (365 days). */
export const ESCROW_MAX_DURATION_SECONDS = 365n * 24n * 3600n;
