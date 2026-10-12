/**
 * Writes test/vectors/proofs.json: cross-language vectors for the Python SDK (scope
 * derivation, bounds, request hashes, gate nonces, Poseidon leaves, a small tree) plus one
 * complete gate-issued request with a real proof, its root record and tampered variants with
 * the reason each must be refused for, and a proof for an on-chain scope id with its
 * AgentClaimsVerifier calldata. Everything is deterministic except the proofs and the gate's
 * random request_id; the vectors test recomputes the deterministic part.
 *   pnpm --filter @agentbank/proofs vectors
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, stringToBytes } from "viem";
import { onchainScopeId, toBytes32 } from "../src/field";
import { createProofGate, encodeHeaderJson, encodeProof, PROOF_HEADERS } from "../src/http";
import { toClaimsVerifierArgs } from "../src/onchain";
import { prove } from "../src/prover";
import {
  canPayPerTx,
  createProofRequest,
  requestHash,
  verifiedCompany,
  type ProofRequest,
} from "../src/request";
import {
  publicSignals,
  releaseProverResources,
  type ProofPresentation,
  type RootInfo,
} from "../src/verifier";
import {
  AGENT_SECRET,
  buildFixture,
  CHAIN_ID,
  GATE_KEY,
  GATE_REQUIREMENTS,
  NOW,
  REGISTRY,
  rootInfoJson,
  SCOPE,
} from "../test/fixtures";
import { claimsArgsJson, deterministicVectors, ONCHAIN_CONSUMER, ONCHAIN_CONTEXT } from "../test/vector-data";

const TTL_SECONDS = 300;
const fixture = buildFixture();
const gateOptions = {
  scope: SCOPE,
  key: GATE_KEY,
  require: GATE_REQUIREMENTS,
  ttlSeconds: TTL_SECONDS,
  chainId: CHAIN_ID,
  registry: REGISTRY,
  now: () => NOW,
};
const gate = createProofGate({ ...gateOptions, rootResolver: async () => fixture.rootInfo });
const request = gate.createRequest();
const presentation = await prove({ secret: AGENT_SECRET, witness: fixture.reservationWitness, request });
const root = presentation.root;

const accepted = await gate.check({ [PROOF_HEADERS.proof]: encodeProof({ request, presentation }) });
if (accepted.kind !== "verified") throw new Error(`the fresh proof did not verify: ${accepted.reason}`);

// A proof for an on-chain consumer (the contracts repository's claims fixtures' consumer and
// context on Base Sepolia): its scope signal is AgentClaimsVerifier.scopeOf(consumer, context).
const onchainRequest = createProofRequest({
  scope: onchainScopeId(CHAIN_ID, ONCHAIN_CONSUMER, ONCHAIN_CONTEXT),
  require: [verifiedCompany(), canPayPerTx("5.00")],
  now: NOW,
  chainId: CHAIN_ID,
  registry: REGISTRY,
  requestId: "0123456789abcdef0123456789abcdef",
  nonce: `0x${"0c".repeat(31)}`,
});
const onchainPresentation = await prove({
  secret: AGENT_SECRET,
  witness: fixture.baseWitness,
  request: onchainRequest,
});

interface Tampered {
  name: string;
  request: unknown;
  presentation: unknown;
  root_info: ReturnType<typeof rootInfoJson> | null;
  now: number;
  submit_twice?: boolean;
  expected_reason: string;
}

const info = (overrides: Partial<RootInfo> = {}) => rootInfoJson({ ...fixture.rootInfo, ...overrides }, root);
const swap = (p: Partial<ProofPresentation>): ProofPresentation => ({ ...presentation, ...p });
const altered: ProofRequest = {
  ...request,
  constraints: { ...request.constraints, per_tx_limit: { min: "4.00" } },
};
const tampered: Tampered[] = [
  {
    name: "malformed_presentation",
    request,
    presentation: { ...presentation, root: "0xnot-hex" },
    root_info: info(),
    now: NOW,
    expected_reason: "malformed",
  },
  {
    name: "root_outside_field",
    request,
    presentation: swap({ root: `0x${"ff".repeat(32)}` }),
    root_info: info(),
    now: NOW,
    expected_reason: "malformed",
  },
  {
    name: "request_expired",
    request,
    presentation,
    root_info: info(),
    now: request.expires_at + 1,
    expected_reason: "request_expired",
  },
  {
    name: "constraints_changed_after_issue",
    request: altered,
    presentation: swap({ request_hash: requestHash(altered) }),
    root_info: info(),
    now: NOW,
    expected_reason: "nonce_invalid",
  },
  {
    name: "forged_nonce",
    request: { ...request, nonce: `0x${"ab".repeat(31)}` },
    presentation,
    root_info: info(),
    now: NOW,
    expected_reason: "nonce_invalid",
  },
  {
    name: "replayed",
    request,
    presentation,
    root_info: info(),
    now: NOW,
    submit_twice: true,
    expected_reason: "nonce_reused",
  },
  {
    name: "request_hash_mismatch",
    request,
    presentation: swap({ request_hash: keccak256(stringToBytes("another request")) }),
    root_info: info(),
    now: NOW,
    expected_reason: "request_hash_mismatch",
  },
  { name: "unknown_root", request, presentation, root_info: null, now: NOW, expected_reason: "unknown_root" },
  {
    name: "root_revoked",
    request,
    presentation,
    root_info: info({ revoked: true }),
    now: NOW,
    expected_reason: "root_revoked",
  },
  {
    name: "root_expired",
    request,
    presentation,
    root_info: info({ validUntil: NOW - 1 }),
    now: NOW,
    expected_reason: "root_expired",
  },
  {
    name: "root_too_old",
    request,
    presentation,
    root_info: info({ snapshotAt: NOW - request.max_root_age_seconds - 1 }),
    now: NOW,
    expected_reason: "root_too_old",
  },
  {
    name: "anonymity_set_too_small",
    request,
    presentation,
    root_info: info({ leafCount: request.min_anonymity_set - 1 }),
    now: NOW,
    expected_reason: "anonymity_set_too_small",
  },
  {
    name: "nullifier_swapped",
    request,
    presentation: swap({ nullifier: toBytes32(12345n) }),
    root_info: info(),
    now: NOW,
    expected_reason: "invalid_proof",
  },
  {
    name: "proof_point_not_on_curve",
    request,
    presentation: swap({ proof: { ...presentation.proof, pi_c: ["1", "1", "1"] } }),
    root_info: info(),
    now: NOW,
    expected_reason: "invalid_proof",
  },
];

const vectors = {
  ...deterministicVectors(),
  proof: {
    description:
      "A gate-issued request (createProofGate with gate.key_utf8 at gate.now) and the agent's presentation from its reservation leaf. A ProofGate configured like `gate` must accept AGENT-PROOF = base64(json({ request, presentation })) at gate.now when the root resolves to root_info, then refuse the same header as nonce_reused.",
    gate: {
      scope: SCOPE,
      key_utf8: GATE_KEY,
      now: NOW,
      ttl_seconds: TTL_SECONDS,
      chain_id: CHAIN_ID,
      registry: REGISTRY,
      min_anonymity_set: request.min_anonymity_set,
      max_root_age_seconds: request.max_root_age_seconds,
    },
    secret: AGENT_SECRET,
    witness: fixture.reservationWitness,
    request,
    request_hash: requestHash(request),
    presentation,
    agent_proof_header: encodeProof({ request, presentation }),
    root_info: info(),
    public_signals: publicSignals(request, presentation),
    claims_verifier_args: claimsArgsJson(toClaimsVerifierArgs(request, presentation)),
    expected: { valid: true, reason: null, nullifier: accepted.nullifier, root },
  },
  onchain_proof: {
    description:
      "A request for an on-chain consumer (scope = onchainScopeId(chain_id, consumer, context), so the scope signal is AgentClaimsVerifier.scopeOf(consumer, context) on that chain) and the agent's presentation from its base leaf. verify_presentation(request, presentation, root_info, now) must accept it; claims_verifier_args are the AgentClaimsVerifier.verify / verifyAndConsume arguments.",
    chain_id: CHAIN_ID,
    consumer: ONCHAIN_CONSUMER,
    context: ONCHAIN_CONTEXT,
    now: NOW,
    request: onchainRequest,
    request_hash: requestHash(onchainRequest),
    presentation: onchainPresentation,
    root_info: rootInfoJson(fixture.rootInfo, onchainPresentation.root),
    public_signals: publicSignals(onchainRequest, onchainPresentation),
    claims_verifier_args: claimsArgsJson(toClaimsVerifierArgs(onchainRequest, onchainPresentation)),
  },
  tampered: tampered.map((t) => ({
    ...t,
    agent_proof_header: encodeHeaderJson({ request: t.request, presentation: t.presentation }),
  })),
};

await releaseProverResources();
const out = resolve(dirname(fileURLToPath(import.meta.url)), "../test/vectors/proofs.json");
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${out}`);
