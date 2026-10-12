import { DISCLOSURE_CLASSES } from "@agentbank/core/api";
import { createProofGate as createBaseProofGate } from "@agentbank/proofs/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentClient,
  fetchWithProof,
  generateProofSecret,
  onchainScopeId,
  ProofError,
  releaseProofResources,
  requestHash,
  type AgentClientOptions,
  type FetchLike,
  type ProofPresentation,
  type ProofRequest,
} from "../src";
import {
  apiRootResolver,
  canPayPerTx,
  createProofGate,
  decodeProofRequired,
  proofOf,
  verifiedCompany,
  withProofGate,
  type ProofGateOptions,
} from "../src/proof-server";
import { createPaywall, withPaywall } from "../src/x402-server";
import { startFakeApi, type FakeApi } from "./helpers/fake-api";
import { createLocalFacilitator } from "./helpers/x402-facilitator";

const ACCT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SES = "ses_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SELLER = "0x7777777777777777777777777777777777777777";
const SCOPE = "api.seller.example";
const URL_ = `http://${SCOPE}/report`;
const GATE_KEY = "agentbank-sdk-test-gate-key-0123456789abcdef";
const sessionKey = privateKeyToAccount(generatePrivateKey());
const spendKey = privateKeyToAccount(generatePrivateKey());
const secret = generateProofSecret();

let api: FakeApi;

beforeAll(async () => {
  api = await startFakeApi({
    sessions: [{ id: SES, address: sessionKey.address, accountId: ACCT }],
    accounts: [{ id: ACCT }],
    spendAddress: spendKey.address,
    proofs: { defaultSettings: { enabled: true, disclose: [...DISCLOSURE_CLASSES] } },
  });
  await agent().proofs.enroll();
});

afterAll(async () => {
  await api.close();
  await releaseProofResources();
});

function agent(overrides: Partial<AgentClientOptions> = {}): AgentClient {
  return new AgentClient({
    baseUrl: api.url,
    accountId: ACCT,
    session: { id: SES, signer: sessionKey },
    spendKey,
    proofSecret: secret,
    validateResponses: true,
    ...overrides,
  });
}

interface Seen {
  proof: boolean;
  payment: boolean;
  status: number;
  reason?: string | null;
}

/**
 * A seller whose resource needs a proof (verified company that can pay $5 a call) and a $0.05
 * payment: the proof gate first, then the x402 paywall, as one Web handler.
 */
function seller(options: { twoPhase?: boolean; gate?: Partial<ProofGateOptions> } = {}) {
  const local = createLocalFacilitator();
  const paywall = createPaywall({
    facilitatorUrl: "http://facilitator.test/v1/x402",
    fetch: local.fetch,
    payTo: SELLER,
    price: "0.05",
  });
  const gateOptions: ProofGateOptions = {
    scope: SCOPE,
    key: GATE_KEY,
    require: [verifiedCompany(), canPayPerTx("5.00")],
    rootResolver: apiRootResolver(api.url),
    ...options.gate,
  };
  const gate = options.twoPhase === false ? createBaseProofGate(gateOptions) : createProofGate(gateOptions);
  const handler = withProofGate(
    gate,
    withPaywall(paywall, async (request) =>
      Response.json({ report: 42, agent: proofOf(request)?.nullifier }),
    ),
    { beforePaywall: true },
  );
  const seen: Seen[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const response = await handler(request);
    const body =
      response.status === 401 ? ((await response.clone().json()) as { reason: string | null }) : undefined;
    seen.push({
      proof: request.headers.has("AGENT-PROOF"),
      payment: request.headers.has("PAYMENT-SIGNATURE"),
      status: response.status,
      ...(body ? { reason: body.reason } : {}),
    });
    return response;
  };
  return { local, fetch, seen };
}

const witnessFetches = () => api.requests.filter((r) => r.url.includes("/proofs/witness")).length;

describe("fetchWithPayment answers proof challenges, then pays", () => {
  it("proves once, keeps the proof on the paid retry, and reports the nullifier", async () => {
    const shop = seller();
    const client = agent({ x402: { network: "eip155:84532", fetch: shop.fetch } });
    const before = witnessFetches();
    const result = await client.fetchWithPayment(URL_);
    expect(result.response.status).toBe(200);
    const body = (await result.response.json()) as { report: number; agent: string };
    expect(body.report).toBe(42);
    expect(result).toMatchObject({ paid: true, amount: "0.05", proofPresented: true });
    expect(result.nullifier).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.nullifier).toBe(body.agent);
    expect(result.proofRequest?.scope).toBe(SCOPE);
    expect(result.settlement?.success).toBe(true);
    expect(shop.local.settled).toHaveLength(1);
    expect(shop.seen).toEqual([
      { proof: false, payment: false, status: 401, reason: null },
      { proof: true, payment: false, status: 402 },
      { proof: true, payment: true, status: 200 },
    ]);
    expect(witnessFetches() - before).toBe(1);
  });

  it("re-proves once when a gate used the proof up on the 402 (a gate without peek/commit)", async () => {
    const shop = seller({ twoPhase: false });
    const client = agent({ x402: { network: "eip155:84532", fetch: shop.fetch } });
    const before = witnessFetches();
    const result = await client.fetchWithPayment(URL_);
    expect(result.response.status).toBe(200);
    expect(result).toMatchObject({ paid: true, proofPresented: true });
    expect(shop.seen).toEqual([
      { proof: false, payment: false, status: 401, reason: null },
      { proof: true, payment: false, status: 402 },
      { proof: true, payment: true, status: 401, reason: "nonce_reused" },
      { proof: true, payment: true, status: 200 },
    ]);
    expect(witnessFetches() - before).toBe(2);
    expect(shop.local.settled).toHaveLength(1);
  });

  it("returns the 401 unchanged without a proof secret", async () => {
    const shop = seller();
    const client = agent({ proofSecret: undefined, x402: { network: "eip155:84532", fetch: shop.fetch } });
    const before = witnessFetches();
    const result = await client.fetchWithPayment(URL_);
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("WWW-Authenticate")).toBe(`AgentProof realm="${SCOPE}"`);
    expect(decodeProofRequired(result.response.headers.get("AGENT-PROOF-REQUIRED") ?? "").scope).toBe(SCOPE);
    expect(result).toMatchObject({ paid: false, proofPresented: false });
    expect(witnessFetches()).toBe(before);
    expect((await client.fetch(URL_)).status).toBe(401);
  });

  it("refuses a challenge for another verifier's scope (a relayed challenge) without proving", async () => {
    const shop = seller({ gate: { scope: "bank.example" } });
    const client = agent({ x402: { network: "eip155:84532", fetch: shop.fetch } });
    const before = witnessFetches();
    const error = await client.fetchWithPayment(URL_).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProofError);
    expect(error).toMatchObject({ reason: "scope_mismatch", code: "forbidden" });
    expect(witnessFetches()).toBe(before);
  });

  it("never answers a challenge for an on-chain scope id, even when acceptScope allows it", async () => {
    const onchain = onchainScopeId(84532, SELLER, `0x${"01".repeat(32)}`);
    const shop = seller({ gate: { scope: onchain } });
    const client = agent({
      x402: { network: "eip155:84532", fetch: shop.fetch },
      proofs: { acceptScope: () => true },
    });
    const before = witnessFetches();
    const error = await client.fetchWithPayment(URL_).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProofError);
    expect(error).toMatchObject({ reason: "scope_mismatch", request: { scope: onchain } });
    expect((error as Error).message).toMatch(/on-chain scope/);
    const standalone = await fetchWithProof(shop.fetch, URL_, undefined, {
      prover: client.proofs,
      acceptScope: () => true,
    }).catch((e: unknown) => e);
    expect(standalone).toMatchObject({ reason: "scope_mismatch" });
    expect(witnessFetches()).toBe(before);
  });
});

describe("fetchWithProof", () => {
  /** A prover that answers with a well-formed presentation the gate cannot accept. */
  function bogusProver(calls: ProofRequest[]) {
    return {
      canProve: true,
      async prove(request: ProofRequest): Promise<ProofPresentation> {
        calls.push(request);
        return {
          type: "agentbank.proof.v1",
          request_hash: requestHash(request),
          root: `0x${"12".repeat(32)}`,
          nullifier: `0x${"23".repeat(32)}`,
          proof: {
            pi_a: ["1", "2", "1"],
            pi_b: [
              ["1", "2"],
              ["3", "4"],
              ["1", "0"],
            ],
            pi_c: ["1", "2", "1"],
            protocol: "groth16",
            curve: "bn128",
          },
        };
      },
    };
  }

  it("treats a challenge in answer to a fresh proof as a rejection, with the verifier's reason", async () => {
    const shop = seller();
    const calls: ProofRequest[] = [];
    const error = await fetchWithProof(shop.fetch, URL_, undefined, { prover: bogusProver(calls) }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProofError);
    expect(error).toMatchObject({
      reason: "proof_rejected",
      verifierReason: "unknown_root",
      code: "unauthorized",
    });
    expect((error as ProofError).response?.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(shop.seen.map((s) => s.status)).toEqual([401, 401]);
  });

  it("passes free resources through, and leaves challenges unanswered when the prover cannot prove", async () => {
    const free: FetchLike = async () => Response.json({ free: true });
    const result = await fetchWithProof(free, URL_, undefined, { prover: bogusProver([]) });
    expect(result).toMatchObject({ proofPresented: false });
    expect(await result.response.json()).toEqual({ free: true });

    const shop = seller();
    const unanswered = await fetchWithProof(
      shop.fetch,
      URL_,
      { method: "POST", body: "q=1" },
      {
        prover: { canProve: false, prove: () => Promise.reject(new Error("unused")) },
      },
    );
    expect(unanswered.response.status).toBe(401);
    expect(unanswered.proofPresented).toBe(false);

    const calls: ProofRequest[] = [];
    const relayed = await fetchWithProof(shop.fetch, "http://evil.example/report", undefined, {
      prover: bogusProver(calls),
    }).catch((e: unknown) => e);
    expect(relayed).toMatchObject({ reason: "scope_mismatch" });
    expect(calls).toHaveLength(0);
    const accepted = await fetchWithProof(shop.fetch, "http://evil.example/report", undefined, {
      prover: bogusProver(calls),
      acceptScope: () => true,
    }).catch((e: unknown) => e);
    expect(accepted).toMatchObject({ reason: "proof_rejected" });
    expect(calls).toHaveLength(1);
  });
});
