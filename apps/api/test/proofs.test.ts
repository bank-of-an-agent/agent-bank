import { SIMULATED_ATTESTER } from "@agentbank/chain";
import { CHAINS, newId, ownerPayloads, usdc } from "@agentbank/core";
import {
  balanceAtLeast,
  canPayPerTx,
  createProofRequest,
  disclosureMask,
  generateProofSecret,
  identityCommitment,
  MAX_U64,
  ProofRefusedError,
  requestHash,
  reservedFor,
  reputation,
  scopeTagOf,
  SNARK_SCALAR_FIELD,
  toBytes32,
  VERIFICATION_KEY,
  verifiedCompany,
  type DisclosureClass,
  type ProofRequest,
} from "@agentbank/proofs";
import { prepareProof, prove } from "@agentbank/proofs/prover";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pocket } from "../src/domain/ledger-refs";
import { loadConfig } from "../src/config";
import { applyDueUnfreezes } from "../src/domain/freeze";
import { epochSaltLeaf, proofAttester } from "../src/domain/proofs";
import { createAttester } from "../src/wiring";
import { runProofReservations, runProofRoots } from "../src/jobs/proofs";
import { agentCall, call, createHarness, ownerAuth, type Harness, type Json } from "./support/harness";
import { onboard, payAndSign, type World } from "./support/flows";

const ALL_CLASSES: DisclosureClass[] = [
  "principal",
  "limits",
  "balance",
  "reservations",
  "account_age",
  "reputation",
];
const SCOPE = "api.seller.test";
const money = (amount: string) => ({ amount, asset: "USDC" });

let h: Harness;
/** The crafted prover: approved company, caps $25 / $100, funded, two settled payments, escrows. */
let w: World;
/** Its counterparty (receives a payment, pays an escrow to `w`). */
let other: World;
/** An agent of an unverified org that discloses only principal and limits. */
let u: World;
const secrets = new Map<string, Hex>();
/** The first proof, kept to show that it stops verifying once its root is revoked. */
let firstProof: { req: ProofRequest; presentation: Json; root: string };

beforeAll(async () => {
  h = await createHarness();
  w = await onboard(h, {
    name: "prover",
    fund: usdc("1234.56"),
    policy: { limits: { per_tx: "25.00", per_day: "100.00" }, counterparties: { mode: "open" } },
  });
  other = await onboard(h, { name: "counterparty", fund: usdc("50") });
  u = await onboard(h, { name: "unverified" });
  await h.db.query("UPDATE org SET kyc_status = 'pending' WHERE id = $1", [u.org.id]);
});
afterAll(async () => h.close());

// ---------------------------------------------------------------- helpers

async function putSettings(world: World, enabled: boolean, disclose: DisclosureClass[], sign = true) {
  const body: Record<string, unknown> = { enabled, disclose };
  if (sign) {
    const owner = ownerPayloads.proofsDisclose(world.agent.id, { enabled, disclose });
    body.owner_authorization = await ownerAuth(
      world.owner,
      h.clock,
      owner.action,
      owner.subject,
      owner.payload,
    );
  }
  return call(h.app, "PUT", `/v1/agents/${world.agent.id}/proofs/settings`, { token: world.apiKey, body });
}

async function enroll(world: World, secret: Hex = generateProofSecret()) {
  const res = await agentCall(h, world.session, "PUT", `/v1/accounts/${world.account.id}/proofs/identity`, {
    body: { identity_commitment: toBytes32(identityCommitment(secret)) },
  });
  if (res.status === 200) secrets.set(world.account.id, secret);
  return res;
}

function witness(world: World, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  return agentCall(
    h,
    world.session,
    "GET",
    `/v1/accounts/${world.account.id}/proofs/witness${qs ? `?${qs}` : ""}`,
  );
}

async function treeState(): Promise<{ dirty: boolean; narrowing: boolean } | undefined> {
  const { rows } = await h.db.query<{ dirty: boolean; narrowing: boolean }>(
    "SELECT dirty, narrowing FROM proof_tree_state WHERE chain_id = 1337",
  );
  return rows[0];
}

async function roots(): Promise<Json[]> {
  const res = await call(h.app, "GET", "/v1/proofs/roots?limit=200");
  expect(res.status).toBe(200);
  return res.body.data;
}

function request(
  require: Parameters<typeof createProofRequest>[0]["require"],
  extra: Partial<Parameters<typeof createProofRequest>[0]> = {},
): ProofRequest {
  return createProofRequest({
    scope: SCOPE,
    require,
    chainId: 1337,
    minAnonymitySet: 1,
    now: h.clock.now(),
    ...extra,
  });
}

async function verify(req: ProofRequest, presentation: unknown) {
  const res = await call(h.app, "POST", "/v1/proofs/verify", { body: { request: req, presentation } });
  expect(res.status).toBe(200);
  return res.body;
}

function isValidOnChain(root: string): boolean {
  return h.sim.attestations.isValidRoot(root as Hex, h.sim.head.timestamp);
}

async function leafOf(accountId: string, epoch: string, reservationId: string | null = null) {
  const { rows } = await h.db.query<{ attributes: Record<string, string>; disclosure_mask: number }>(
    `SELECT attributes, disclosure_mask FROM proof_leaf
      WHERE chain_id = 1337 AND epoch = $1 AND account_id = $2 AND reservation_id IS NOT DISTINCT FROM $3`,
    [BigInt(epoch), accountId, reservationId],
  );
  return rows[0];
}

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// ---------------------------------------------------------------- circuit

describe("circuit", () => {
  it("publishes the schema, verification key and where roots are anchored", async () => {
    const res = await call(h.app, "GET", "/v1/proofs/circuit");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: "proof_circuit",
      schema: "agentbank.claims.v1",
      tree_depth: 20,
      constraints: 10_270,
      chain_id: 1337,
      registry: h.chain.contracts.attestationRegistry,
      verifier: h.chain.contracts.claimsVerifier,
    });
    expect(res.body.attributes).toHaveLength(13);
    expect(res.body.disclosure_classes.limits).toEqual(["per_tx_limit", "per_day_limit"]);
    expect(res.body.public_signals).toHaveLength(30);
    expect(res.body.verification_key).toEqual(VERIFICATION_KEY);
    expect(res.body.sha256.zkey).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------- settings

describe("settings (owner control)", () => {
  it("defaults to disabled with nothing disclosed", async () => {
    const res = await call(h.app, "GET", `/v1/agents/${w.agent.id}/proofs/settings`, { token: w.apiKey });
    expect(res.body).toEqual({
      object: "proof_settings",
      agent_id: w.agent.id,
      enabled: false,
      disclose: [],
      disclosure_mask: 0,
      updated_at: null,
    });
  });

  it("needs the owner's signature to widen, and only an API key to narrow", async () => {
    const unsigned = await putSettings(w, true, ["principal"], false);
    expect(unsigned.status).toBe(403);
    expect(unsigned.body.code).toBe("owner_signature_required");
    expect(unsigned.body.payload).toEqual({ agent_id: w.agent.id, enabled: true, disclose: ["principal"] });

    // Signed for other classes than requested: the signature does not cover this change.
    const owner = ownerPayloads.proofsDisclose(w.agent.id, { enabled: true, disclose: ["principal"] });
    const mismatched = await call(h.app, "PUT", `/v1/agents/${w.agent.id}/proofs/settings`, {
      token: w.apiKey,
      body: {
        enabled: true,
        disclose: ["principal", "balance"],
        owner_authorization: await ownerAuth(w.owner, h.clock, owner.action, owner.subject, owner.payload),
      },
    });
    expect(mismatched.status).toBe(401);
    expect(mismatched.body.code).toBe("signature_invalid");
    // Signed by someone else than the owner.
    const stranger = await ownerAuth(other.owner, h.clock, owner.action, owner.subject, owner.payload);
    const foreign = await call(h.app, "PUT", `/v1/agents/${w.agent.id}/proofs/settings`, {
      token: w.apiKey,
      body: { enabled: true, disclose: ["principal"], owner_authorization: stranger },
    });
    expect(foreign.body.code).toBe("owner_signature_required");

    // Classes may be listed in any order: the owner signs the sorted set.
    const enabled = await putSettings(w, true, ["reputation", "principal", "limits"]);
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({
      enabled: true,
      disclose: ["principal", "limits", "reputation"],
      disclosure_mask: disclosureMask(["principal", "limits", "reputation"]),
    });
    expect(await treeState()).toMatchObject({ dirty: true, narrowing: false });

    const narrowed = await putSettings(w, true, ["principal", "limits"], false);
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.disclose).toEqual(["principal", "limits"]);
    expect(await treeState()).toMatchObject({ dirty: true, narrowing: true });

    const reAdd = await putSettings(w, true, ["principal", "limits", "reputation"], false);
    expect(reAdd.body.code).toBe("owner_signature_required");

    const all = await putSettings(w, true, ALL_CLASSES);
    expect(all.body.disclosure_mask).toBe(8191);
    const events = await call(h.app, "GET", "/v1/events?type=proof_settings.updated", { token: w.apiKey });
    expect(events.body.data.length).toBeGreaterThanOrEqual(3);
  });

  it("is a principal operation scoped to the org", async () => {
    const byAgent = await agentCall(h, w.session, "GET", `/v1/agents/${w.agent.id}/proofs/settings`);
    expect(byAgent.status).toBe(403);
    const otherOrg = await call(h.app, "GET", `/v1/agents/${w.agent.id}/proofs/settings`, {
      token: other.apiKey,
    });
    expect(otherOrg.status).toBe(404);
    const otherWrite = await call(h.app, "PUT", `/v1/agents/${w.agent.id}/proofs/settings`, {
      token: other.apiKey,
      body: { enabled: false, disclose: [] },
    });
    expect(otherWrite.status).toBe(404);
  });
});

// ---------------------------------------------------------------- identity

describe("identity enrollment", () => {
  it("accepts only non-zero field elements, from the account's own agent", async () => {
    const missing = await agentCall(h, w.session, "GET", `/v1/accounts/${w.account.id}/proofs/identity`);
    expect(missing.status).toBe(404);
    expect(missing.body.reason).toBe("not_enrolled");

    const zero = await agentCall(h, w.session, "PUT", `/v1/accounts/${w.account.id}/proofs/identity`, {
      body: { identity_commitment: toBytes32(0n) },
    });
    expect(zero.status).toBe(400);
    const outside = await agentCall(h, w.session, "PUT", `/v1/accounts/${w.account.id}/proofs/identity`, {
      body: { identity_commitment: toBytes32(SNARK_SCALAR_FIELD) },
    });
    expect(outside.status).toBe(400);

    const commitment = toBytes32(identityCommitment(generateProofSecret()));
    const byPrincipal = await call(h.app, "PUT", `/v1/accounts/${w.account.id}/proofs/identity`, {
      token: w.apiKey,
      body: { identity_commitment: commitment },
    });
    expect(byPrincipal.status).toBe(403);
    const byOtherAgent = await agentCall(
      h,
      other.session,
      "PUT",
      `/v1/accounts/${w.account.id}/proofs/identity`,
      {
        body: { identity_commitment: commitment },
      },
    );
    expect(byOtherAgent.status).toBe(404);

    const enrolled = await enroll(w);
    expect(enrolled.status).toBe(200);
    expect(enrolled.body).toMatchObject({
      object: "proof_identity",
      account_id: w.account.id,
      identity_commitment: toBytes32(identityCommitment(secrets.get(w.account.id) as Hex)),
    });
    const again = await enroll(w, secrets.get(w.account.id));
    expect(again.body).toEqual(enrolled.body);
    const read = await call(h.app, "GET", `/v1/accounts/${w.account.id}/proofs/identity`, {
      token: w.apiKey,
    });
    expect(read.body).toEqual(enrolled.body);
    const foreign = await call(h.app, "GET", `/v1/accounts/${w.account.id}/proofs/identity`, {
      token: other.apiKey,
    });
    expect(foreign.status).toBe(404);
  });
});

describe("agents without proofs enabled", () => {
  it("get no witness and cannot reserve", async () => {
    const res = await witness(other);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "invalid_state", reason: "proofs_disabled" });
    const reserve = await agentCall(
      h,
      other.session,
      "POST",
      `/v1/accounts/${other.account.id}/proofs/reservations`,
      {
        body: {
          amount: money("1.00"),
          scope: SCOPE,
          expires_at: new Date(h.clock.now().getTime() + 3_600_000).toISOString(),
        },
      },
    );
    expect(reserve.status).toBe(409);
    expect(reserve.body.reason).toBe("proofs_disabled");
  });
});

// ---------------------------------------------------------------- attested facts and roots

describe("attested facts", () => {
  let epoch: string;

  it("attests the crafted agent's 13 attributes exactly", async () => {
    // Two settled outgoing payments: one to an outside address, one to the counterparty agent.
    const first = await payAndSign(h, w, {
      amount: money("10.50"),
      to: { address: "0x5555555555555555555555555555555555555555" },
    });
    const second = await payAndSign(h, w, { amount: money("5.25"), to: { agent_id: other.agent.id } });
    expect([first.body.status, second.body.status]).toEqual(["submitted", "submitted"]);
    await h.indexer.sync();
    expect(await h.ledger.balance(pocket(w.account.id, "operating"))).toBe(usdc("1218.7785"));

    // Escrows: one released to `w` by the counterparty (whom `w` also paid: one counterparty),
    // resolved disputes with `w` as payee or payer receiving less, half, or more than half.
    const escrow = async (payer: World, payee: string, status: string, split: [string, string] | null) => {
      await h.db.query(
        `INSERT INTO escrow (id, payer_account_id, payee_address, amount, fee, status, release_mode, contract_address,
                             expires_at, org_id, resolution_payee_amount, resolution_payer_amount)
         VALUES ($1, $2, $3, $4, 0, $5, 'arbiter', $6, now() + interval '1 day', $7, $8, $9)`,
        [
          newId("escrow", h.clock.now().getTime()),
          payer.account.id,
          payee,
          usdc("10"),
          status,
          h.chain.contracts.escrow as string,
          payer.org.id,
          split ? usdc(split[0]) : null,
          split ? usdc(split[1]) : null,
        ],
      );
    };
    const wAddress = (w.account.address as string).toLowerCase(); // matched case-insensitively
    await escrow(other, wAddress, "released", null);
    await escrow(other, w.account.address, "refunded", null);
    await escrow(other, w.account.address, "resolved", ["3", "7"]); // payee w got 3 of 10: lost
    await escrow(other, w.account.address, "resolved", ["5", "5"]); // exactly half: not lost
    await escrow(w, other.account.address, "resolved", ["4", "6"]); // payer w got 6: not lost
    await escrow(w, other.account.address, "resolved", ["8", "2"]); // payer w got 2: lost
    await escrow(other, w.account.address, "resolved", null); // no recorded split: ignored

    expect(await runProofRoots(h.deps)).toBe(1);
    const [root] = await roots();
    expect(root).toMatchObject({ status: "published", leaf_count: 1, chain_id: 1337, epoch: "1" });
    epoch = root.epoch;
    const leaf = await leafOf(w.account.id, epoch);
    const createdOn = Math.floor(unix(w.account.created_at) / 86_400) * 86_400;
    expect(leaf).toEqual({
      disclosure_mask: 8191,
      attributes: {
        principal_verification: "2",
        per_tx_limit: "25000000",
        per_day_limit: "100000000",
        balance: "1218000000",
        reserved_amount: "0",
        reserved_until: "0",
        reserved_for: "0",
        account_created_on: String(createdOn),
        payments_settled: "2",
        volume_settled: "15000000",
        escrows_completed: "1",
        disputes_lost: "2",
        counterparties: "2",
      },
    });
    expect(createdOn).toBe(Date.UTC(2026, 9, 11) / 1000);
  });

  it("publishes the root to the registry and serves it", async () => {
    const [root] = await roots();
    expect(isValidOnChain(root.root)).toBe(true);
    const onChain = await h.chain.getAttestationRoot(root.root);
    expect(onChain).toMatchObject({ epoch: 1n, leafCount: 1, revoked: false, valid: true });
    expect(BigInt(unix(root.valid_until) - unix(root.snapshot_at))).toBe(7_200n);
    const one = await call(h.app, "GET", `/v1/proofs/roots/${root.root.toUpperCase().replace("0X", "0x")}`);
    expect(one.body).toEqual(root);
    expect(root.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(root.registry).toBe(h.chain.contracts.attestationRegistry);
    expect((await call(h.app, "GET", `/v1/proofs/roots/0x${"12".repeat(32)}`)).status).toBe(404);
    expect(await treeState()).toMatchObject({ dirty: false, narrowing: false });
    // Nothing changed and the root is fresh: no new root.
    expect(await runProofRoots(h.deps)).toBe(0);
  });

  it("serves a witness the real prover turns into a proof the API verifies", async () => {
    const res = await witness(w);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: "proof_witness",
      account_id: w.account.id,
      chain_id: 1337,
      epoch,
      leaf_count: 1,
      leaf_index: 0,
      reservation_id: null,
      disclosure_mask: 8191,
    });
    expect(res.body.registry?.toLowerCase()).toBe(
      (h.chain.contracts.attestationRegistry as string).toLowerCase(),
    );
    const req = request(
      [
        verifiedCompany(),
        canPayPerTx("5.00"),
        balanceAtLeast("1000.00"),
        reputation({ paymentsSettled: 2, escrowsCompleted: 1, disputesLostAtMost: 2, counterparties: 2 }),
      ],
      { ttlSeconds: 3_600 },
    );
    const presentation = await prove({
      secret: secrets.get(w.account.id) as Hex,
      witness: res.body,
      request: req,
    });
    const verified = await verify(req, presentation);
    expect(verified).toMatchObject({
      object: "proof_verification",
      valid: true,
      reason: null,
      root: res.body.root,
      root_status: "published",
    });
    expect(verified.nullifier).toBe(presentation.nullifier);
    firstProof = { req, presentation, root: res.body.root };

    // The anonymity set the request asks for is the request's own.
    const crowded = request([verifiedCompany()], { minAnonymitySet: 16 });
    const tooSmall = await verify(crowded, { ...presentation, request_hash: requestHash(crowded) });
    expect(tooSmall).toMatchObject({
      valid: false,
      reason: "anonymity_set_too_small",
      root_status: "published",
    });
    const unknown = await verify(req, { ...presentation, root: toBytes32(12345n) });
    expect(unknown).toMatchObject({ valid: false, reason: "unknown_root", root_status: null });
    const tampered = await verify(req, { ...presentation, request_hash: toBytes32(1n) });
    expect(tampered.reason).toBe("request_hash_mismatch");
    const otherChain = request([verifiedCompany()], { chainId: 84532 });
    const elsewhere = await verify(otherChain, { ...presentation, request_hash: requestHash(otherChain) });
    expect(elsewhere.reason).toBe("unknown_root");
    const forged = await verify(req, {
      ...presentation,
      proof: { ...presentation.proof, pi_a: [presentation.proof.pi_c[0], presentation.proof.pi_c[1], "1"] },
    });
    expect(forged).toMatchObject({ valid: false, reason: "invalid_proof" });
  });

  it("refuses proofs a witness cannot back: unverified principal, undisclosed classes, forged values", async () => {
    expect((await putSettings(u, true, ["principal", "limits"])).status).toBe(200);
    expect((await enroll(u)).status).toBe(200);
    const notYet = await witness(u);
    expect(notYet.status).toBe(409);
    expect(notYet.body.reason).toBe("proof_not_ready");
    expect(await runProofRoots(h.deps)).toBe(1);
    const res = await witness(u);
    expect(res.body).toMatchObject({
      leaf_count: 2,
      disclosure_mask: disclosureMask(["principal", "limits"]),
    });
    expect(res.body.attributes).toMatchObject({ principal_verification: "0", per_tx_limit: "1000000000" });
    const secret = secrets.get(u.account.id) as Hex;

    const company = request([verifiedCompany()]);
    expect(() => prepareProof({ secret, witness: res.body, request: company })).toThrow(ProofRefusedError);
    try {
      prepareProof({ secret, witness: res.body, request: company });
    } catch (error) {
      expect((error as ProofRefusedError).reason).toBe("unsatisfiable");
    }
    const balance = request([canPayPerTx("5.00"), balanceAtLeast("1.00")]);
    try {
      prepareProof({ secret, witness: res.body, request: balance });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProofRefusedError);
      expect((error as ProofRefusedError).reason).toBe("undisclosed");
      expect((error as ProofRefusedError).undisclosedClasses).toEqual(["balance"]);
    }
    // Claiming company status by editing the witness breaks the Merkle path.
    const forged = { ...res.body, attributes: { ...res.body.attributes, principal_verification: "2" } };
    try {
      prepareProof({ secret, witness: forged, request: company });
      expect.unreachable();
    } catch (error) {
      expect((error as ProofRefusedError).reason).toBe("witness_mismatch");
    }
  });

  it("serves witnesses only to the account's own agent, and only for valid roots", async () => {
    expect(
      (await agentCall(h, other.session, "GET", `/v1/accounts/${w.account.id}/proofs/witness`)).status,
    ).toBe(404);
    const byPrincipal = await call(h.app, "GET", `/v1/accounts/${w.account.id}/proofs/witness`, {
      token: w.apiKey,
    });
    expect(byPrincipal.status).toBe(403);
    const named = await witness(w, { root: firstProof.root });
    expect(named.status).toBe(200);
    expect(named.body.epoch).toBe("1");
    expect((await witness(w, { root: toBytes32(99n) })).body.reason).toBe("unknown_root");
    // Settings enabled but no identity yet (`other` stays enabled and unenrolled: not in the tree).
    await putSettings(other, true, ["principal"]);
    const unenrolled = await witness(other);
    expect(unenrolled.status).toBe(404);
    expect(unenrolled.body.reason).toBe("not_enrolled");
  });

  it("lists roots newest first, with filters and cursors", async () => {
    const all = await roots();
    expect(all.map((r) => r.epoch)).toEqual(["2", "1"]);
    const page = await call(h.app, "GET", "/v1/proofs/roots?limit=1");
    expect(page.body.data).toHaveLength(1);
    const next = await call(h.app, "GET", `/v1/proofs/roots?limit=1&cursor=${page.body.next_cursor}`);
    expect(next.body.data[0].epoch).toBe("1");
    expect(next.body.next_cursor).toBeNull();
    const published = await call(h.app, "GET", "/v1/proofs/roots?status=published");
    expect(published.body.data).toHaveLength(2);
    expect((await call(h.app, "GET", "/v1/proofs/roots?status=revoked")).body.data).toEqual([]);
    expect((await call(h.app, "GET", "/v1/proofs/roots?cursor=bogus")).status).toBe(400);
  });
});

// ---------------------------------------------------------------- reservations (proof of funds)

describe("reservations", () => {
  let reservation: Json;
  let reservationRoot: string;

  it("validate the class, the amount, the expiry and the funds", async () => {
    const at = (seconds: number) => new Date(h.clock.now().getTime() + seconds * 1000).toISOString();
    const create = (world: World, body: Record<string, unknown>) =>
      agentCall(h, world.session, "POST", `/v1/accounts/${world.account.id}/proofs/reservations`, { body });
    const undisclosed = await create(u, { amount: money("1.00"), scope: SCOPE, expires_at: at(3_600) });
    expect(undisclosed.status).toBe(409);
    expect(undisclosed.body.reason).toBe("reservations_not_disclosed");
    const notDisclosed = await create(other, { amount: money("1.00"), scope: SCOPE, expires_at: at(3_600) });
    expect(notDisclosed.body.reason).toBe("reservations_not_disclosed");
    expect((await create(w, { amount: money("1.00"), scope: SCOPE, expires_at: at(30) })).status).toBe(400);
    expect(
      (await create(w, { amount: money("1.00"), scope: SCOPE, expires_at: at(8 * 86_400) })).status,
    ).toBe(400);
    expect(
      (await create(w, { amount: money("1.00"), scope: SCOPE, scope_tag: "5", expires_at: at(3_600) }))
        .status,
    ).toBe(400);
    expect((await create(w, { amount: money("0"), scope: SCOPE, expires_at: at(3_600) })).status).toBe(400);
    const broke = await create(w, { amount: money("5000.00"), scope: SCOPE, expires_at: at(3_600) });
    expect(broke.status).toBe(422);
    expect(broke.body.code).toBe("insufficient_funds");
    const byPrincipal = await call(h.app, "POST", `/v1/accounts/${w.account.id}/proofs/reservations`, {
      token: w.apiKey,
      body: { amount: money("1.00"), scope: SCOPE, expires_at: at(3_600) },
    });
    expect(byPrincipal.status).toBe(403);
  });

  it("hold the amount and become a leaf tagged for the verifier", async () => {
    const expiresAt = new Date(h.clock.now().getTime() + 3_600_000).toISOString();
    const res = await agentCall(h, w.session, "POST", `/v1/accounts/${w.account.id}/proofs/reservations`, {
      body: { amount: money("500.00"), scope: SCOPE, expires_at: expiresAt },
    });
    expect(res.status).toBe(201);
    reservation = res.body;
    expect(reservation).toMatchObject({
      object: "proof_reservation",
      account_id: w.account.id,
      agent_id: w.agent.id,
      amount: money("500.00"),
      scope_tag: scopeTagOf(SCOPE).toString(),
      status: "pending",
      included_in_epoch: null,
      released_at: null,
    });
    expect(reservation.id).toMatch(/^prv_/);
    expect(await h.ledger.balance(pocket(w.account.id, "operating"))).toBe(usdc("718.7785"));
    expect(await h.ledger.balance(pocket(w.account.id, "reserved"))).toBe(usdc("500"));
    const hold = await h.ledger.getHold(reservation.hold_id);
    expect(hold).toMatchObject({ status: "pending", refType: "proof_reservation", refId: reservation.id });
    const balances = await agentCall(h, w.session, "GET", `/v1/accounts/${w.account.id}/balances`);
    expect(balances.body.available).toBe("718.7785");

    // Spending continues from what is left; the reserved amount is not available to it.
    const spend = await payAndSign(h, w, { amount: money("20.00"), to: { agent_id: other.agent.id } });
    expect(spend.body.status).toBe("submitted");
    await h.indexer.sync();

    expect(await runProofRoots(h.deps)).toBe(1);
    const leaf = await leafOf(w.account.id, "3", reservation.id);
    expect(leaf?.attributes).toMatchObject({
      reserved_amount: "500000000",
      reserved_until: String(unix(expiresAt)),
      reserved_for: scopeTagOf(SCOPE).toString(),
      balance: "698000000",
    });
    const fetched = await agentCall(h, w.session, "GET", `/v1/proofs/reservations/${reservation.id}`);
    expect(fetched.body).toMatchObject({ status: "active", included_in_epoch: "3" });
    const listed = await call(
      h.app,
      "GET",
      `/v1/accounts/${w.account.id}/proofs/reservations?status=active`,
      {
        token: w.apiKey,
      },
    );
    expect(listed.body.data.map((r: Json) => r.id)).toEqual([reservation.id]);
    const none = await agentCall(
      h,
      w.session,
      "GET",
      `/v1/accounts/${w.account.id}/proofs/reservations?status=released`,
    );
    expect(none.body.data).toEqual([]);
    expect(
      (await agentCall(h, other.session, "GET", `/v1/proofs/reservations/${reservation.id}`)).status,
    ).toBe(404);
    const events = await call(h.app, "GET", "/v1/events?type=proof_reservation.created", { token: w.apiKey });
    expect(events.body.data[0].data.id).toBe(reservation.id);
  });

  it("prove funds reserved for their own verifier only", async () => {
    const res = await witness(w, { reservation_id: reservation.id });
    expect(res.status).toBe(200);
    // Leaves are ordered by account id, then reservation id (the base leaf first).
    const wFirst = (w.account.id as string) < (u.account.id as string);
    expect(res.body).toMatchObject({
      reservation_id: reservation.id,
      leaf_count: 3,
      leaf_index: wFirst ? 1 : 2,
    });
    reservationRoot = res.body.root;
    const secret = secrets.get(w.account.id) as Hex;
    const req = request([reservedFor("500.00", { forSeconds: 1_800 }), verifiedCompany()]);
    const presentation = await prove({ secret, witness: res.body, request: req });
    expect((await verify(req, presentation)).valid).toBe(true);

    const elsewhere = request([reservedFor("500.00", { forSeconds: 1_800 })], { scope: "other.seller.test" });
    try {
      prepareProof({ secret, witness: res.body, request: elsewhere });
      expect.unreachable();
    } catch (error) {
      expect((error as ProofRefusedError).reason).toBe("unsatisfiable");
      expect((error as ProofRefusedError).attributes).toEqual(["reserved_for"]);
    }
    // The base leaf carries no reservation.
    const base = await witness(w);
    expect(() => prepareProof({ secret, witness: base.body, request: req })).toThrow(ProofRefusedError);
    const missing = await witness(w, { reservation_id: "prv_01J00000000000000000000000" });
    expect(missing.status).toBe(404);
  });

  it("are released early only with the owner's signature, which revokes older roots", async () => {
    const before = await roots();
    const valid = before.filter((r) => r.status === "published").map((r) => r.root as string);
    expect(valid.length).toBe(3);
    expect(valid.every(isValidOnChain)).toBe(true);

    const unsigned = await call(h.app, "POST", `/v1/proofs/reservations/${reservation.id}/release`, {
      token: w.apiKey,
      body: {},
    });
    expect(unsigned.status).toBe(400);
    const byAgent = await agentCall(
      h,
      w.session,
      "POST",
      `/v1/proofs/reservations/${reservation.id}/release`,
      {
        body: {},
      },
    );
    expect(byAgent.status).toBe(403);
    const owner = ownerPayloads.proofReservationRelease(reservation.id);
    const foreign = await call(h.app, "POST", `/v1/proofs/reservations/${reservation.id}/release`, {
      token: w.apiKey,
      body: {
        owner_authorization: await ownerAuth(
          other.owner,
          h.clock,
          owner.action,
          owner.subject,
          owner.payload,
        ),
      },
    });
    expect(foreign.body.code).toBe("owner_signature_required");
    const released = await call(h.app, "POST", `/v1/proofs/reservations/${reservation.id}/release`, {
      token: w.apiKey,
      body: {
        owner_authorization: await ownerAuth(w.owner, h.clock, owner.action, owner.subject, owner.payload),
      },
    });
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ status: "released", released_at: h.clock.now().toISOString() });
    expect((await h.ledger.getHold(reservation.hold_id)).status).toBe("voided");
    expect(await h.ledger.balance(pocket(w.account.id, "reserved"))).toBe(0n);
    expect(await treeState()).toMatchObject({ dirty: true, narrowing: true });
    const again = await call(h.app, "POST", `/v1/proofs/reservations/${reservation.id}/release`, {
      token: w.apiKey,
      body: {
        owner_authorization: await ownerAuth(w.owner, h.clock, owner.action, owner.subject, owner.payload),
      },
    });
    expect(again.status).toBe(409);
    expect((await witness(w, { reservation_id: reservation.id })).body.reason).toBe("reservation_closed");

    expect(await runProofRoots(h.deps)).toBe(4); // one root published, three revoked
    const after = await roots();
    expect(after[0]).toMatchObject({ epoch: "4", status: "published", leaf_count: 2 });
    for (const root of valid) {
      expect(after.find((r) => r.root === root)?.status).toBe("revoked");
      expect(isValidOnChain(root)).toBe(false);
    }
    expect(isValidOnChain(after[0].root)).toBe(true);
    // Proofs against revoked roots stop verifying.
    expect(await verify(firstProof.req, firstProof.presentation)).toMatchObject({
      valid: false,
      reason: "root_revoked",
    });
    expect(reservationRoot).not.toBe(after[0].root);
    const events = await call(h.app, "GET", "/v1/events?type=proof_reservation.released", {
      token: w.apiKey,
    });
    expect(events.body.data).toHaveLength(1);
  });

  it("expire: the hold is voided and the funds return", async () => {
    const expiresAt = new Date(h.clock.now().getTime() + 120_000).toISOString();
    const res = await agentCall(h, w.session, "POST", `/v1/accounts/${w.account.id}/proofs/reservations`, {
      body: { amount: money("100.00"), scope_tag: "42", expires_at: expiresAt },
    });
    expect(res.status).toBe(201);
    expect(res.body.scope_tag).toBe("42");
    expect(await runProofReservations(h.deps)).toBe(0);
    h.clock.advanceSeconds(180);
    const listed = await agentCall(h, w.session, "GET", `/v1/proofs/reservations/${res.body.id}`);
    expect(listed.body.status).toBe("expired"); // read as expired before the worker runs
    expect(await runProofReservations(h.deps)).toBe(1);
    expect((await h.ledger.getHold(res.body.hold_id)).status).toBe("voided");
    expect(await h.ledger.balance(pocket(w.account.id, "reserved"))).toBe(0n);
    const events = await call(h.app, "GET", "/v1/events?type=proof_reservation.expired", { token: w.apiKey });
    expect(events.body.data[0].data).toMatchObject({ id: res.body.id, status: "expired" });
    expect(await treeState()).toMatchObject({ dirty: true, narrowing: false });
    expect(await runProofRoots(h.deps)).toBe(1);
  });
});

// ---------------------------------------------------------------- narrowing changes

describe("narrowing changes", () => {
  it("re-enrollment replaces the leaf and revokes roots of the old commitment", async () => {
    const beforeRoot = (await roots())[0].root as string;
    expect((await enroll(w)).status).toBe(200);
    expect(await treeState()).toMatchObject({ dirty: true, narrowing: true });
    expect((await witness(w)).body.reason).toBe("proof_not_ready"); // old leaves no longer match
    await runProofRoots(h.deps);
    expect(isValidOnChain(beforeRoot)).toBe(false);
    const res = await witness(w);
    expect(res.status).toBe(200);
    expect(() =>
      prepareProof({
        secret: secrets.get(w.account.id) as Hex,
        witness: res.body,
        request: request([verifiedCompany()]),
      }),
    ).not.toThrow();
  });

  it("narrowing is served at once: no witness discloses more than the owner now allows", async () => {
    const narrower = ALL_CLASSES.filter((c) => c !== "balance");
    expect((await putSettings(w, true, narrower, false)).status).toBe(200);
    const pending = await witness(w);
    expect(pending.status).toBe(409);
    expect(pending.body.reason).toBe("proof_not_ready");
    await runProofRoots(h.deps);
    const res = await witness(w);
    expect(res.status).toBe(200);
    expect(res.body.disclosure_mask).toBe(disclosureMask(narrower));
    expect((await putSettings(w, true, ALL_CLASSES)).status).toBe(200);
    await runProofRoots(h.deps);
    expect((await witness(w)).body.disclosure_mask).toBe(8191);
  });

  it("freezing an agent removes it from the tree and revokes older roots", async () => {
    const beforeRoot = (await roots())[0];
    expect(beforeRoot.leaf_count).toBe(2);
    const frozen = await call(h.app, "POST", `/v1/agents/${u.agent.id}/freeze`, {
      token: u.apiKey,
      body: { reason: "investigation" },
    });
    expect(frozen.status).toBe(200);
    expect(await treeState()).toMatchObject({ dirty: true, narrowing: true });
    await runProofRoots(h.deps);
    const [latest] = await roots();
    expect(latest.leaf_count).toBe(1);
    expect(isValidOnChain(beforeRoot.root)).toBe(false);
    const refused = await witness(u);
    expect(refused.status).toBe(423);
    expect(refused.body.code).toBe("agent_frozen");
  });

  it("disabling the last agent revokes every root without publishing an empty tree", async () => {
    const [latest] = await roots();
    expect((await putSettings(w, false, ALL_CLASSES, false)).status).toBe(200);
    expect(await runProofRoots(h.deps)).toBe(1);
    const after = await roots();
    expect(after[0]).toMatchObject({ root: latest.root, status: "revoked" });
    expect(isValidOnChain(latest.root)).toBe(false);
    expect(await treeState()).toMatchObject({ dirty: false, narrowing: false });
    expect(await runProofRoots(h.deps)).toBe(0);
  });
});

// ---------------------------------------------------------------- publication on an asynchronous chain

describe("publication", () => {
  it("waits for receipts, fails reverted or lost roots and rebuilds them", async () => {
    expect((await putSettings(w, true, ["principal"])).status).toBe(200);
    // An EVM chain: the receipt is not there at once.
    let receipts: "pending" | "reverted" | "real" = "pending";
    const chain = Object.create(h.deps.chain) as typeof h.deps.chain;
    chain.getTransactionReceipt = async (hash) =>
      receipts === "pending"
        ? null
        : receipts === "reverted"
          ? { status: "reverted", blockNumber: 1n }
          : h.deps.chain.getTransactionReceipt(hash);
    const deps = { ...h.deps, chain };
    expect(await runProofRoots(deps)).toBe(1);
    let [latest] = await roots();
    expect(latest.status).toBe("publishing");
    expect(await runProofRoots(deps)).toBe(0); // still pending: nothing else is built
    receipts = "real";
    expect(await runProofRoots(deps)).toBe(1);
    [latest] = await roots();
    expect(latest.status).toBe("published");
    expect(latest.published_at).not.toBeNull();

    // A reverted publication fails the root and keeps the change pending.
    receipts = "reverted";
    expect((await putSettings(w, true, ["principal", "limits"])).status).toBe(200);
    expect(await runProofRoots(deps)).toBe(1);
    [latest] = await roots();
    expect(latest.status).toBe("failed");
    expect(await treeState()).toMatchObject({ dirty: true });

    // Not mined within 30 minutes: failed too.
    receipts = "pending";
    expect(await runProofRoots(deps)).toBe(1);
    h.clock.advanceSeconds(31 * 60);
    expect(await runProofRoots(deps)).toBeGreaterThanOrEqual(1);
    const statuses = (await roots()).slice(0, 3).map((r) => r.status);
    expect(statuses).toContain("failed");

    // The registry is ahead of this database: skip to its next epoch.
    receipts = "real";
    const ahead = Object.create(h.deps.chain) as typeof h.deps.chain;
    ahead.publishAttestationRoot = async () => {
      throw new Error("Transaction would revert: EpochNotIncreasing(41, 9)");
    };
    await h.db.query("UPDATE proof_tree_state SET dirty = true");
    const failing = { ...h.deps, chain: ahead };
    await runProofRoots(failing);
    expect(await runProofRoots(h.deps)).toBeGreaterThanOrEqual(1);
    [latest] = await roots();
    expect(latest).toMatchObject({ epoch: "42", status: "published" });
    expect(isValidOnChain(latest.root)).toBe(true);
  });

  it("salts every epoch's tree so unchanged facts still yield a new root", async () => {
    const [latest] = await roots();
    h.clock.advanceSeconds(3_601);
    expect(await runProofRoots(h.deps)).toBe(1);
    const [next] = await roots();
    expect(next.epoch).toBe("43");
    expect(next.root).not.toBe(latest.root);
    expect(next.leaf_count).toBe(latest.leaf_count);
    expect(epochSaltLeaf(1337, 43n)).not.toBe(epochSaltLeaf(1337, 42n));
    expect(epochSaltLeaf(1337, 43n)).toBeLessThan(SNARK_SCALAR_FIELD);
  });

  it("prunes leaves a day after a root lapses", async () => {
    h.clock.advanceSeconds(2 * 86_400);
    expect(await runProofReservations(h.deps)).toBeGreaterThan(0);
    const { rows } = await h.db.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM proof_leaf");
    expect(rows[0]?.n).toBe(0n);
    const expired = await call(h.app, "GET", "/v1/proofs/roots?status=expired");
    expect(expired.body.data.length).toBeGreaterThan(0);
    expect(MAX_U64).toBe((1n << 64n) - 1n);
  });
});

// ---------------------------------------------------------------- the attester

describe("attester", () => {
  it("is the configured key, the public simulated attester on the simulated chain, else a clear refusal", async () => {
    expect(proofAttester(h.deps).address).toBe(SIMULATED_ATTESTER);
    expect(proofAttester({ ...h.deps, attester: undefined }).address).toBe(SIMULATED_ATTESTER);
    const sepolia = { ...h.deps.config, chain: CHAINS["base-sepolia"] };
    expect(() => proofAttester({ ...h.deps, attester: undefined, config: sepolia })).toThrow(
      /PROOFS_ATTESTER_KEY is not configured/,
    );
    const base = {
      NODE_ENV: "test",
      DATABASE_URL: "pglite://memory",
      AGENTBANK_CHAIN: "base-sepolia",
      CHAIN_RPC_URL: "https://sepolia.base.org",
      REVENUE_ADDRESS: "0x1111111111111111111111111111111111111111",
    };
    expect(createAttester(loadConfig(base))).toBeUndefined();
    const key = `0x${"44".repeat(32)}` as Hex;
    expect(createAttester(loadConfig({ ...base, PROOFS_ATTESTER_KEY: key }))?.address).toBe(
      privateKeyToAccount(key).address,
    );
    expect(createAttester(h.deps.config)?.address).toBe(SIMULATED_ATTESTER);
  });

  it("refuses to build roots without a registry on the chain", async () => {
    const chain = Object.create(h.deps.chain) as typeof h.deps.chain;
    Object.defineProperty(chain, "contracts", {
      value: { ...h.deps.chain.contracts, attestationRegistry: undefined },
    });
    await h.db.query("UPDATE proof_tree_state SET dirty = true");
    await expect(runProofRoots({ ...h.deps, chain })).rejects.toThrow(
      /AgentAttestationRegistry is not configured/,
    );
    const circuit = await call(h.app, "GET", "/v1/proofs/circuit");
    expect(circuit.body.registry).toBe(h.chain.contracts.attestationRegistry);
  });
});

describe("unfreezing", () => {
  it("brings the agent back into the tree at the next root", async () => {
    await h.db.query("UPDATE agent SET pending_unfreeze_at = $2 WHERE id = $1", [
      u.agent.id,
      new Date(h.clock.now().getTime() - 1_000),
    ]);
    await h.db.query("UPDATE proof_tree_state SET dirty = false, narrowing = false");
    expect(await applyDueUnfreezes(h.deps, h.clock.now())).toBe(1);
    expect(await treeState()).toMatchObject({ dirty: true, narrowing: false });
    expect(await runProofRoots(h.deps)).toBeGreaterThanOrEqual(1);
    const [latest] = await roots();
    expect(latest.status).toBe("published");
    // (Its session expired with the clock jumps above; the leaf is there for its next session.)
    expect((await leafOf(u.account.id, latest.epoch))?.attributes.principal_verification).toBe("0");
  });
});

// ---------------------------------------------------------------- feature flag

describe("feature flag", () => {
  it("answers feature_gated and runs no root job when FEATURE_PRIVATE_PROOFS is off", async () => {
    const gated = await createHarness({ config: { FEATURE_PRIVATE_PROOFS: "false" } });
    try {
      const circuit = await call(gated.app, "GET", "/v1/proofs/circuit");
      expect(circuit.status).toBe(403);
      expect(circuit.body.code).toBe("feature_gated");
      const g = await onboard(gated, { name: "gated" });
      const settings = await call(gated.app, "GET", `/v1/agents/${g.agent.id}/proofs/settings`, {
        token: g.apiKey,
      });
      expect(settings.body.code).toBe("feature_gated");
      // Reservations stay readable (and releasable) so held funds are never stranded.
      const list = await call(gated.app, "GET", `/v1/accounts/${g.account.id}/proofs/reservations`, {
        token: g.apiKey,
      });
      expect(list.status).toBe(200);
      expect(await runProofRoots(gated.deps)).toBe(0);
      const meta = await call(gated.app, "GET", "/v1/meta");
      expect(meta.body.features.private_proofs).toBe(false);
    } finally {
      await gated.close();
    }
  });
});
