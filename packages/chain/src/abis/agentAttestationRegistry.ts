/**
 * `AgentAttestationRegistry` (contracts/src/interfaces/IAgentAttestationRegistry.sol): roots of
 * Agent Bank's attested-facts Merkle trees (schema `agentbank.claims.v1`). The attester key
 * publishes roots; the attester or the owner (an `Ownable2Step` governance multisig) revokes them.
 * The registry holds and moves no funds. Exactly the interface: functions, events and errors (the
 * deployed contract adds the `Ownable2Step` surface).
 */
export const agentAttestationRegistryAbi = [
  {
    type: "function",
    name: "MAX_VALIDITY",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "SNARK_SCALAR_FIELD",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "attester",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "latestEpoch",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "latestRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "rootInfo",
    stateMutability: "view",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "epoch", type: "uint64" },
          { name: "snapshotAt", type: "uint64" },
          { name: "publishedAt", type: "uint64" },
          { name: "validUntil", type: "uint64" },
          { name: "leafCount", type: "uint32" },
          { name: "revoked", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "isValidRoot",
    stateMutability: "view",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "publishRoot",
    stateMutability: "nonpayable",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "epoch", type: "uint64" },
      { name: "snapshotAt", type: "uint64" },
      { name: "validUntil", type: "uint64" },
      { name: "leafCount", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeRoots",
    stateMutability: "nonpayable",
    inputs: [{ name: "roots", type: "bytes32[]" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setAttester",
    stateMutability: "nonpayable",
    inputs: [{ name: "newAttester", type: "address" }],
    outputs: [],
  },
  {
    type: "event",
    name: "RootPublished",
    inputs: [
      { name: "root", type: "bytes32", indexed: true },
      { name: "epoch", type: "uint64", indexed: true },
      { name: "snapshotAt", type: "uint64", indexed: false },
      { name: "validUntil", type: "uint64", indexed: false },
      { name: "leafCount", type: "uint32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RootRevoked",
    inputs: [
      { name: "root", type: "bytes32", indexed: true },
      { name: "by", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "AttesterChanged",
    inputs: [
      { name: "previousAttester", type: "address", indexed: true },
      { name: "newAttester", type: "address", indexed: true },
    ],
  },
  { type: "error", name: "NotAttester", inputs: [{ name: "caller", type: "address" }] },
  { type: "error", name: "NotAttesterOrOwner", inputs: [{ name: "caller", type: "address" }] },
  { type: "error", name: "InvalidRoot", inputs: [{ name: "root", type: "bytes32" }] },
  { type: "error", name: "RootAlreadyPublished", inputs: [{ name: "root", type: "bytes32" }] },
  { type: "error", name: "UnknownRoot", inputs: [{ name: "root", type: "bytes32" }] },
  {
    type: "error",
    name: "EpochNotIncreasing",
    inputs: [
      { name: "latestEpoch", type: "uint64" },
      { name: "epoch", type: "uint64" },
    ],
  },
  { type: "error", name: "SnapshotInFuture", inputs: [{ name: "snapshotAt", type: "uint64" }] },
  { type: "error", name: "InvalidValidity", inputs: [{ name: "validUntil", type: "uint64" }] },
  { type: "error", name: "EmptyTree", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
] as const;

/**
 * OpenZeppelin `Ownable` errors (the deployed registry is `Ownable2Step`; `onlyOwner` reverts with
 * `OwnableUnauthorizedAccount`). Not part of `IAgentAttestationRegistry`.
 */
export const ownableErrorsAbi = [
  { type: "error", name: "OwnableUnauthorizedAccount", inputs: [{ name: "account", type: "address" }] },
  { type: "error", name: "OwnableInvalidOwner", inputs: [{ name: "owner", type: "address" }] },
] as const;

/** `AgentAttestationRegistry.MAX_VALIDITY`: longest validity window from publication (7 days), seconds. */
export const ATTESTATION_MAX_VALIDITY_SECONDS = 7n * 24n * 3600n;

/** `AgentAttestationRegistry.SNARK_SCALAR_FIELD`: the BN254 scalar field order; roots are field elements. */
export const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
