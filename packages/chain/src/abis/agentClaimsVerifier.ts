const claimsComponents = [
  { name: "root", type: "bytes32" },
  { name: "nullifier", type: "uint256" },
  { name: "scope", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "mins", type: "uint64[13]" },
  { name: "maxs", type: "uint64[13]" },
] as const;

const proofComponents = [
  { name: "a", type: "uint256[2]" },
  { name: "b", type: "uint256[2][2]" },
  { name: "c", type: "uint256[2]" },
] as const;

/**
 * `AgentClaimsVerifier` (contracts/src/interfaces/IAgentClaimsVerifier.sol): checks
 * `agentbank.claims.v1` Groth16 proofs against roots in the `AgentAttestationRegistry`. Exactly the
 * interface: functions, events and errors. Agent Bank verifies proofs off-chain; this ABI is for
 * clients and contracts that verify on-chain.
 */
export const agentClaimsVerifierAbi = [
  {
    type: "function",
    name: "ATTRIBUTE_COUNT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "registry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "groth16Verifier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "scopeOf",
    stateMutability: "view",
    inputs: [
      { name: "consumer", type: "address" },
      { name: "context", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "nonceUsed",
    stateMutability: "view",
    inputs: [
      { name: "scope", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "verify",
    stateMutability: "view",
    inputs: [
      { name: "claims", type: "tuple", components: claimsComponents },
      { name: "proof", type: "tuple", components: proofComponents },
      { name: "minAnonymitySet", type: "uint32" },
      { name: "maxRootAge", type: "uint64" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "verifyAndConsume",
    stateMutability: "nonpayable",
    inputs: [
      { name: "context", type: "bytes32" },
      { name: "claims", type: "tuple", components: claimsComponents },
      { name: "proof", type: "tuple", components: proofComponents },
      { name: "minAnonymitySet", type: "uint32" },
      { name: "maxRootAge", type: "uint64" },
    ],
    outputs: [{ name: "nullifier", type: "uint256" }],
  },
  {
    type: "event",
    name: "ClaimsAccepted",
    inputs: [
      { name: "consumer", type: "address", indexed: true },
      { name: "scope", type: "uint256", indexed: true },
      { name: "nullifier", type: "uint256", indexed: true },
      { name: "root", type: "bytes32", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "RootNotValid", inputs: [{ name: "root", type: "bytes32" }] },
  {
    type: "error",
    name: "RootTooOld",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "snapshotAt", type: "uint64" },
      { name: "maxRootAge", type: "uint64" },
    ],
  },
  {
    type: "error",
    name: "AnonymitySetTooSmall",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "leafCount", type: "uint32" },
      { name: "minAnonymitySet", type: "uint32" },
    ],
  },
  { type: "error", name: "InvalidProof", inputs: [] },
  {
    type: "error",
    name: "ScopeMismatch",
    inputs: [
      { name: "expected", type: "uint256" },
      { name: "actual", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "NonceAlreadyUsed",
    inputs: [
      { name: "scope", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  },
  { type: "error", name: "FieldElementOutOfRange", inputs: [] },
] as const;
