/**
 * The HTTP binding of private proofs (headers and their encoding), loaded lazily: its module
 * graph includes the verifier, and with it snarkjs, which the main entry point does without.
 */
export {
  decodeProof,
  decodeProofRequired,
  decodeProofResponse,
  encodeProof,
  PROOF_HEADERS,
} from "@agentbank/proofs/http";
