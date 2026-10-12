import { inspect } from "node:util";
import { DISCLOSURE_CLASSES } from "@agentbank/core/api";
import { decodeFunctionData, encodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentBankClient,
  AgentClient,
  generateProofSecret,
  identityCommitment,
  InvalidRequestError,
  NotFoundError,
  PermissionDeniedError,
  onchainScopeId,
  ProofError,
  releaseProofResources,
  scopeField,
  scopeTagOf,
  type AgentClientOptions,
  type ProofRequest,
} from "../src";
import {
  apiRootResolver,
  balanceAtLeast,
  canPayPerTx,
  CLAIMS_VERIFIER_ABI,
  createProofRequest,
  decodeProof,
  encodeProofRequired,
  onchainScope,
  reputation,
  reservedFor,
  toClaimsVerifierArgs,
  verifiedCompany,
  verifyPresentation,
  type Requirement,
} from "../src/proof-server";
import * as proverEntry from "../src/prover";
import { startFakeApi, type FakeApi } from "./helpers/fake-api";

const ACCT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
const AGENT = "agt_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SES = "ses_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SCOPE = "api.seller.example";
const sessionKey = privateKeyToAccount(generatePrivateKey());
const secret = generateProofSecret();
const commitment = `0x${identityCommitment(secret).toString(16).padStart(64, "0")}`;

let api: FakeApi;

beforeAll(async () => {
  api = await startFakeApi({
    sessions: [{ id: SES, address: sessionKey.address, accountId: ACCT }],
    accounts: [{ id: ACCT, agent_id: AGENT }],
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
    proofSecret: secret,
    validateResponses: true,
    retry: { baseDelayMs: 1, maxDelayMs: 2 },
    ...overrides,
  });
}

const standard: Requirement[] = [
  verifiedCompany(),
  canPayPerTx("5.00"),
  balanceAtLeast("1000.00"),
  reputation({ disputesLostAtMost: 0 }),
];
const request = (
  require: Requirement[] = standard,
  overrides: Partial<Parameters<typeof createProofRequest>[0]> = {},
) => createProofRequest({ scope: SCOPE, require, ...overrides });
const witnessFetches = () => api.requests.filter((r) => r.url.includes("/proofs/witness")).length;
const verify = (req: ProofRequest, presentation: unknown) =>
  verifyPresentation({ request: req, presentation, rootResolver: apiRootResolver(api.url) });

async function proofError(promise: Promise<unknown>): Promise<ProofError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProofError);
  return error as ProofError;
}

describe("enrollment and configuration", () => {
  it("enrolls Poseidon(secret) with a signed agent request; the secret never leaves the client", async () => {
    const client = agent();
    expect(client.proofs.canProve).toBe(true);
    expect(client.proofs.identityCommitment).toBe(commitment);
    const identity = await client.proofs.enroll();
    expect(identity.identity_commitment).toBe(commitment);
    const put = api.requests.at(-1);
    expect(put).toMatchObject({ method: "PUT", url: `/v1/accounts/${ACCT}/proofs/identity`, auth: "agent" });
    expect(JSON.parse(put?.body ?? "{}")).toEqual({ identity_commitment: commitment });
    expect(await client.proofs.identity()).toMatchObject({
      account_id: ACCT,
      identity_commitment: commitment,
    });
    expect(JSON.stringify(api.requests)).not.toContain(secret.slice(2));
    expect(inspect(client, { depth: 6, showHidden: true })).not.toContain(secret.slice(2));
  });

  it("refuses to enroll or prove without a proof secret", async () => {
    const client = agent({ proofSecret: undefined });
    expect(client.proofs.canProve).toBe(false);
    expect(client.proofs.identityCommitment).toBeUndefined();
    expect((await proofError(client.proofs.enroll())).reason).toBe("proof_secret_missing");
    const missing = await proofError(client.proofs.prove(request()));
    expect(missing).toMatchObject({ reason: "proof_secret_missing", code: "invalid_request" });
  });

  it("validates the secret and the options without echoing the secret", () => {
    for (const bad of ["0x00", "0xzz", `0x${"f".repeat(64)}`, "12345"]) {
      const error = (() => {
        try {
          agent({ proofSecret: bad as `0x${string}` });
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(InvalidRequestError);
      expect((error as Error).message).not.toContain(bad.slice(2));
    }
    expect(() => agent({ proofs: { maxPresentationsPerScopePerHour: -1 } })).toThrow(/maxPresentations/);
    expect(() => agent({ proofs: { maxPresentationsPerScopePerHour: 1.5 } })).toThrow(/maxPresentations/);
    expect(() => agent({ proofs: { autoReserve: true as unknown as false } })).toThrow(/autoReserve/);
    expect(() =>
      agent({ proofs: { maxPresentationsPerScopePerHour: Number.POSITIVE_INFINITY } }),
    ).not.toThrow();
  });
});

describe("prove", () => {
  it("proves for real, refuses locally, and guards each scope against probing", async () => {
    const client = agent({ proofs: { maxPresentationsPerScopePerHour: 1 } });

    // A refusal does not use up the scope's slot.
    const unsatisfiable = await proofError(client.proofs.prove(request([balanceAtLeast("5000.00")])));
    expect(unsatisfiable).toMatchObject({
      reason: "unsatisfiable",
      code: "forbidden",
      attributes: ["balance"],
    });

    const req = request();
    const presentation = await client.proofs.prove(req);
    const result = await verify(req, presentation);
    expect(result).toMatchObject({ valid: true, reason: null, nullifier: presentation.nullifier });

    // The public operations need no credentials: the circuit, the roots and server-side verification.
    const anonymous = new AgentBankClient({ baseUrl: api.url, validateResponses: true });
    const before = api.requests.length;
    expect((await anonymous.proofs.verify(req, presentation)).valid).toBe(true);
    expect(await anonymous.proofs.retrieveRoot(presentation.root)).toMatchObject({ status: "published" });
    expect((await anonymous.proofs.listRoots()).data.length).toBeGreaterThan(0);
    expect((await anonymous.proofs.circuit()).attributes).toHaveLength(13);
    expect(api.requests.slice(before).every((r) => r.auth === "none")).toBe(true);

    // Second presentation to the same scope within the hour: refused before fetching a witness.
    const fetches = witnessFetches();
    const limited = await proofError(client.proofs.prove(encodeProofRequired(request())));
    expect(limited).toMatchObject({ reason: "rate_limited", code: "rate_limited" });
    expect(limited.retryAfterMs).toBeGreaterThan(3_500_000);
    expect(witnessFetches()).toBe(fetches);

    // Another scope has its own budget (this one then fails for its own reason).
    const other = request([balanceAtLeast("5000.00")], { scope: "other.example" });
    expect((await proofError(client.proofs.prove(other))).reason).toBe("unsatisfiable");
    expect(
      (await proofError(agent({ proofs: { maxPresentationsPerScopePerHour: 0 } }).proofs.prove(req))).reason,
    ).toBe("rate_limited");
  });

  it("refuses classes the owner did not disclose, a wrong secret, expired, mainnet and malformed requests", async () => {
    api.proofSettings.set(AGENT, {
      object: "proof_settings",
      agent_id: AGENT,
      enabled: true,
      disclose: ["balance", "limits", "principal"],
      disclosure_mask: 0b1111,
      updated_at: new Date().toISOString(),
    });
    try {
      const undisclosed = await proofError(agent().proofs.prove(request()));
      expect(undisclosed).toMatchObject({ reason: "undisclosed", undisclosedClasses: ["reputation"] });
    } finally {
      api.proofSettings.delete(AGENT);
    }

    const stranger = agent({ proofSecret: generateProofSecret() });
    expect((await proofError(stranger.proofs.prove(request()))).reason).toBe("witness_mismatch");

    const fetches = witnessFetches();
    const expired = request(standard, { now: Math.floor(Date.now() / 1000) - 600, ttlSeconds: 60 });
    expect((await proofError(agent().proofs.prove(expired))).reason).toBe("request_expired");
    const mainnet = await agent()
      .proofs.prove(request(standard, { chainId: 8453 }))
      .catch((e: unknown) => e);
    expect(mainnet).toBeInstanceOf(PermissionDeniedError);
    expect((mainnet as PermissionDeniedError).code).toBe("mainnet_locked");
    expect((await proofError(agent().proofs.prove({ nope: 1 } as never))).reason).toBe("invalid_request");
    expect((await proofError(agent().proofs.prove("%%%"))).reason).toBe("invalid_request");
    expect(witnessFetches()).toBe(fetches);
  });
});

describe("on-chain scopes", () => {
  const consumer = "0x00000000000000000000000000000000000A11CE";
  const context = `0x${"42".repeat(32)}` as const;

  it("proves for an on-chain scope id explicitly, with AgentClaimsVerifier calldata", async () => {
    const scope = onchainScopeId(84532, consumer, context);
    expect(scope).toBe(`eip155:84532:${consumer.toLowerCase()}:${context}`);
    const req = createProofRequest({ scope, require: [verifiedCompany(), canPayPerTx("5.00")] });
    const presentation = await agent().proofs.prove(req);
    expect(await verify(req, presentation)).toMatchObject({ valid: true, reason: null });

    const args = toClaimsVerifierArgs(req, presentation);
    expect(args.claims.scope).toBe(onchainScope(84532, consumer, context));
    expect(args.claims.scope).toBe(scopeField(scope));
    expect(args.claims.nonce).toBe(BigInt(req.nonce));
    expect(proverEntry.toClaimsVerifierArgs(req, presentation)).toEqual(args);
    // The arguments fit viem's types for the ABI and encode as the contract expects.
    const verifyCall = encodeFunctionData({
      abi: CLAIMS_VERIFIER_ABI,
      functionName: "verify",
      args: [args.claims, args.proof, 16, 7_200n],
    });
    expect(decodeFunctionData({ abi: CLAIMS_VERIFIER_ABI, data: verifyCall }).args).toEqual([
      args.claims,
      args.proof,
      16,
      7_200n,
    ]);
    const consumeCall = encodeFunctionData({
      abi: proverEntry.CLAIMS_VERIFIER_ABI,
      functionName: "verifyAndConsume",
      args: [context, args.claims, args.proof, 16, 0n],
    });
    expect(consumeCall.slice(0, 10)).not.toBe(verifyCall.slice(0, 10));
  });

  it("never answers on-chain scopes automatically, and refuses contracts on a mainnet", async () => {
    const scope = onchainScopeId(84532, consumer, context);
    const permissive = agent({ proofs: { acceptScope: () => true } });
    expect(permissive.proofs.acceptsScope(scope, new URL("http://api.seller.example/"))).toBe(false);
    expect(permissive.proofs.acceptsScope("anything.example", new URL("http://api.seller.example/"))).toBe(
      true,
    );
    // One probing budget per scope, however the on-chain scope id is spelled.
    const once = agent({ proofs: { maxPresentationsPerScopePerHour: 1 } });
    await once.proofs.prove(createProofRequest({ scope, require: [verifiedCompany()] }));
    const shouted = scope.toUpperCase().replace("EIP155", "eip155").replaceAll("0X", "0x");
    const limited = await proofError(
      once.proofs.prove(createProofRequest({ scope: shouted, require: [verifiedCompany()] })),
    );
    expect(limited.reason).toBe("rate_limited");

    const fetches = witnessFetches();
    const mainnet = await agent()
      .proofs.prove(createProofRequest({ scope: onchainScopeId(8453, consumer, context) }))
      .catch((e: unknown) => e);
    expect(mainnet).toBeInstanceOf(PermissionDeniedError);
    expect((mainnet as PermissionDeniedError).code).toBe("mainnet_locked");
    expect(witnessFetches()).toBe(fetches);
  });
});

describe("reservations", () => {
  it("reserves with canonical amounts and validates input before sending", async () => {
    const client = agent();
    const reservation = await client.proofs.reserve({ amount: "500", scope: SCOPE, forSeconds: 7_200 });
    expect(reservation).toMatchObject({
      account_id: ACCT,
      amount: { amount: "500.00", asset: "USDC" },
      scope_tag: scopeTagOf(SCOPE).toString(),
      status: "active",
    });
    const sent = JSON.parse(api.requests.at(-1)?.body ?? "{}");
    expect(sent).toMatchObject({ amount: { amount: "500.00", asset: "USDC" }, scope: SCOPE });
    expect(Math.abs(Date.parse(sent.expires_at) - (Date.now() + 7_200_000))).toBeLessThan(5_000);
    expect(api.requests.at(-1)?.headers["idempotency-key"]).toBeDefined();

    // Decoys: too small for SCOPE, and another verifier's.
    await client.proofs.reserve({ amount: "100.00", scope: SCOPE, forSeconds: 7_200 });
    const tagged = await client.proofs.reserve({
      amount: "900.00",
      scopeTag: scopeTagOf("other.example"),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(tagged.scope_tag).toBe(scopeTagOf("other.example").toString());
    expect((await client.proofs.reservations()).data).toHaveLength(3);

    const count = api.requests.length;
    const bad: Parameters<typeof client.proofs.reserve>[0][] = [
      { amount: "1.00", scope: SCOPE },
      { amount: "1.00", scope: SCOPE, forSeconds: 120, expiresAt: new Date(Date.now() + 120_000) },
      { amount: "1.00", scope: SCOPE, forSeconds: 604_801 },
      { amount: "1.00", scope: SCOPE, forSeconds: 60 },
      { amount: "1.00", scope: SCOPE, expiresAt: new Date(Date.now() + 30_000) },
      { amount: "1.00", scope: SCOPE, expiresAt: new Date(Date.now() - 1_000) },
      { amount: "1.00", scope: SCOPE, expiresAt: new Date(Date.now() + 8 * 86_400_000).toISOString() },
      { amount: "0", scope: SCOPE, forSeconds: 120 },
      { amount: "1.0000001", scope: SCOPE, forSeconds: 120 },
      { amount: "1.00", scope: SCOPE, scopeTag: "1", forSeconds: 120 },
      { amount: "1.00", scopeTag: "0", forSeconds: 120 },
      { amount: "1.00", scope: "", forSeconds: 120 },
    ];
    for (const input of bad) {
      await expect(client.proofs.reserve(input)).rejects.toThrow(InvalidRequestError);
    }
    expect(api.requests.length).toBe(count);
  });

  it("proves from a matching active reservation, chosen automatically", async () => {
    const client = agent();
    const reservations = (await client.proofs.reservations({ status: "active" })).data;
    const expected = reservations.find(
      (r) => r.amount.amount === "500.00" && r.scope_tag === scopeTagOf(SCOPE).toString(),
    );
    const req = request([verifiedCompany(), reservedFor("500.00", { forSeconds: 3_600 })]);
    const answer = await client.proofs.answer(req);
    expect(api.requests.filter((r) => r.url.includes("/proofs/witness")).at(-1)?.url).toContain(
      `reservation_id=${expected?.id}`,
    );
    expect(answer.headerName).toBe("AGENT-PROOF");
    const envelope = decodeProof(answer.header);
    expect(envelope).toEqual({ request: req, presentation: answer.presentation });
    expect((await verify(req, answer.presentation)).valid).toBe(true);
  });

  it("says what to reserve when nothing matches, and waits for pending reservations", async () => {
    const client = agent();
    const req = request([reservedFor("1000.00", { forSeconds: 3_600 })]);
    const missing = await proofError(client.proofs.prove(req));
    expect(missing).toMatchObject({
      reason: "reservation_required",
      code: "invalid_state",
      reservationNeeded: {
        amount: "1000.00",
        scope: SCOPE,
        scopeTag: scopeTagOf(SCOPE).toString(),
        until: req.issued_at + 3_600,
      },
    });
    expect(missing.message).toContain('proofs.reserve({ amount: "1000.00", scope: "api.seller.example"');

    const pending = await client.proofs.reserve({ amount: "1000.00", scope: SCOPE, forSeconds: 7_200 });
    const stored = api.proofReservations.get(pending.id);
    if (stored) stored.status = "pending";
    const waiting = await proofError(client.proofs.prove(req));
    expect(waiting.reason).toBe("reservation_pending");
    expect(waiting.message).toContain(pending.id);

    // An explicit reservation id skips the selection (and API errors pass through).
    const unknown = await client.proofs
      .prove(req, { reservationId: "prv_01JABCDEFGHJKMNPQRSTVWXYZ9" })
      .catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(NotFoundError);
  });
});
