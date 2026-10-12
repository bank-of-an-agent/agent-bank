import { escrowResolveCall } from "@agentbank/chain";
import { usdc } from "@agentbank/core";
import {
  generateProofSecret,
  PrincipalClient,
  ProofError,
  readPaymentResponse,
  releaseProofResources,
  type ProofPresentation,
  type ProofRequest,
} from "@agentbank/sdk";
import {
  accountOlderThan,
  balanceAtLeast,
  canPayPerTx,
  decodeProof,
  encodeProof,
  PROOF_HEADERS,
  requestHash,
  reputation,
  reservedFor,
  scopeTagOf,
  verifiedCompany,
} from "@agentbank/sdk/proof-server";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onboardAgent, randomAccount, waitFor, type AgentWorld, type OnboardOptions } from "../src/actors";
import { assertGlobalInvariants } from "../src/invariants";
import { resolvingFetch, type FetchLike } from "../src/net";
import {
  enableProofs,
  latestProofRoot,
  listProofRoots,
  ProofStats,
  publishProofRoot,
  refusal,
  registryRoot,
  startProofSeller,
  timedProver,
  waitForRootStatus,
  type ProofSeller,
} from "../src/proofs";
import { writePrivateProofsEvidence } from "../src/proofs-evidence";
import { startStack, type Stack } from "../src/stack";

/**
 * Private proofs end to end (docs/private-proofs.md) on the simulated chain, over real HTTP:
 * owners enable proofs (owner-signed when widening), agents enroll `Poseidon(secret)` and prove
 * with real Groth16 proofs through the TypeScript SDK, the real `proofs-roots` job anchors roots
 * in the simulated `AgentAttestationRegistry`, and two sellers admit agents with
 * `@agentbank/sdk/proof-server` gates that resolve roots through the API.
 *
 * - agent credentials: a verified company and its limits, without revealing the account;
 * - private reputation: settled payments, a completed escrow, a won dispute, account age;
 * - proof of funds: whole-dollar balances and funds reserved for one seller only, released early
 *   by the owner (revoking roots) or expiring;
 * - disclosure control: narrowing and freezing revoke roots at once;
 * - a proof and an x402 payment in one call; replay and tampering at the HTTP level.
 *
 * The stack has a handful of agents, so the gates lower `min_anonymity_set` to 2 (the SDK's
 * default is 16). `gate:proofs` (`E2E_GATE=proofs`) adds timing runs and rewrites
 * `docs/gates/evidence/private-proofs.md`.
 */

const GATE = process.env.E2E_GATE === "proofs";
const TIMING_RUNS = GATE ? 10 : 2;
const SELLER_A = "seller-a.proofs.test";
const SELLER_B = "seller-b.proofs.test";
/** The anonymity set the sellers ask for: lowered from 16 because the stack has few agents. */
const MIN_ANONYMITY_SET = 2;

const stats = new ProofStats();
const startedAt = performance.now();
let stack: Stack;
let sellerA: ProofSeller;
let sellerB: ProofSeller;
let fetchImpl: FetchLike;
let credentialedAgent: AgentWorld | undefined;

const urlA = (path: string) => `https://${SELLER_A}${path}`;
const urlB = (path: string) => `https://${SELLER_B}${path}`;
const inDays = (days: number) => new Date(stack.clock.nowMs() + days * 86_400_000).toISOString();

/** An onboarded agent whose client holds a fresh proof secret and proves with the timed prover. */
function newAgent(name: string, options: OnboardOptions = {}): Promise<AgentWorld> {
  return onboardAgent(stack, {
    name,
    x402Fetch: fetchImpl,
    proofSecret: generateProofSecret(),
    proofs: { prover: timedProver(stats) },
    ...options,
  });
}

/** A company agent that discloses its principal and limits (scenario a's, or a fresh one). */
async function credentialed(): Promise<AgentWorld> {
  if (!credentialedAgent) {
    credentialedAgent = await newAgent("kya-buyer", { fund: usdc("20") });
    await enableProofs(credentialedAgent, ["principal", "limits"]);
    await publishProofRoot(stack);
  }
  return credentialedAgent;
}

/** A proof prepared now (for a fresh challenge of `url`) but sent later. */
async function prepare(world: AgentWorld, url: string) {
  const challenge = await fetchImpl(url);
  expect(challenge.status).toBe(401);
  return world.agent.proofs.answer(challenge.headers.get(PROOF_HEADERS.required) as string);
}

/** Send an `AGENT-PROOF` header by hand; returns the status and the gate's failure reason. */
async function present(url: string, header: string): Promise<{ status: number; reason: string | null }> {
  const response = await fetchImpl(url, { headers: { [PROOF_HEADERS.proof]: header } });
  const body = (await response.json().catch(() => ({}))) as { reason?: string | null };
  return { status: response.status, reason: response.status === 401 ? (body.reason ?? null) : null };
}

async function expectProofError(
  promise: Promise<unknown>,
  reason: ProofError["reason"],
): Promise<ProofError> {
  const error = await refusal(stats, promise);
  expect(error).toBeInstanceOf(ProofError);
  expect((error as ProofError).reason).toBe(reason);
  return error as ProofError;
}

async function available(world: AgentWorld): Promise<{ available: bigint; reserved: bigint }> {
  const balance = await world.agent.balance();
  return { available: usdc(balance.available), reserved: usdc(balance.reserved) };
}

beforeAll(async () => {
  stack = await startStack({ env: { PROOFS_MIN_ANONYMITY_SET: String(MIN_ANONYMITY_SET) } });
  // Seller A also charges with x402: its Agent Bank account is the registered payee of its host.
  const sellerAccount = await onboardAgent(stack, { name: "proofs-seller", x402Domains: [SELLER_A] });
  sellerA = await startProofSeller({
    scope: SELLER_A,
    apiUrl: stack.apiUrl,
    minAnonymitySet: MIN_ANONYMITY_SET,
    stats,
    payTo: sellerAccount.accountAddress,
    facilitatorUrl: stack.facilitatorUrl,
    network: `eip155:${stack.chainId}`,
  });
  sellerB = await startProofSeller({
    scope: SELLER_B,
    apiUrl: stack.apiUrl,
    minAnonymitySet: MIN_ANONYMITY_SET,
    stats,
  });
  fetchImpl = resolvingFetch((host) =>
    host === SELLER_A
      ? `127.0.0.1:${sellerA.port}`
      : host === SELLER_B
        ? `127.0.0.1:${sellerB.port}`
        : undefined,
  );
  for (const seller of [sellerA, sellerB]) {
    seller.route("/credentials", { require: [verifiedCompany(), canPayPerTx("1.00")] });
    seller.route("/bid", { require: [reservedFor("25.00", { forSeconds: 600 })] });
  }
  // Another enrolled agent, so every root hides each prover among at least two leaves.
  const bystander = await newAgent("bystander");
  await enableProofs(bystander, ["principal", "limits", "balance", "account_age", "reputation"]);
}, 180_000);

afterAll(async () => {
  try {
    if (GATE && stack) {
      const roots = await listProofRoots(stack);
      const onchain = await Promise.all(roots.map((r) => registryRoot(stack, r.root)));
      const circuit = (await (await fetch(`${stack.apiUrl}/v1/proofs/circuit`)).json()) as {
        constraints: number;
      };
      writePrivateProofsEvidence(stats, {
        runtimeMs: performance.now() - startedAt,
        roots,
        revokedOnChain: onchain.filter((r) => r?.revoked).length,
        constraints: circuit.constraints,
        minAnonymitySet: MIN_ANONYMITY_SET,
      });
    }
  } finally {
    await sellerA?.close();
    await sellerB?.close();
    await stack?.stopStack();
    await releaseProofResources();
  }
});

describe("agent credentials", () => {
  it("proves a verified company and its limits without revealing the account", async () => {
    const buyer = await newAgent("kya-buyer", { fund: usdc("20") });

    // Widening is the owner's decision: refused with the API key alone, applied once owner-signed.
    const unsigned = await refusal(
      undefined,
      buyer.principal.proofs.updateSettings(buyer.agentId, {
        enabled: true,
        disclose: ["principal", "limits"],
      }),
    );
    expect(unsigned.code).toBe("owner_signature_required");
    const settings = await enableProofs(buyer, ["principal", "limits"]);
    expect(settings).toMatchObject({ enabled: true, disclose: ["principal", "limits"] });
    const identity = await buyer.agent.proofs.identity();
    expect(identity.identity_commitment).toBe(buyer.agent.proofs.identityCommitment);
    credentialedAgent = buyer;

    // The proofs-roots job anchors the tree in AgentAttestationRegistry.
    const root = await publishProofRoot(stack);
    expect(root.leaf_count).toBeGreaterThanOrEqual(MIN_ANONYMITY_SET);
    expect(root.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await registryRoot(stack, root.root)).toMatchObject({
      epoch: BigInt(root.epoch),
      leafCount: root.leaf_count,
      revoked: false,
      valid: true,
    });

    const first = await buyer.agent.fetchWithPayment(urlA("/credentials"));
    expect(first.response.status).toBe(200);
    expect(first).toMatchObject({ proofPresented: true, paid: false });
    const served = (await first.response.json()) as { nullifier: string };
    expect(served.nullifier).toBe(first.nullifier);

    // What the seller saw: a challenge, then a presentation that names no account, agent or org.
    const seen = sellerA.log.filter((r) => r.path === "/credentials");
    expect(seen.map((r) => [r.status, r.proof !== null])).toEqual([
      [401, false],
      [200, true],
    ]);
    const header = seen[1]?.proof as string;
    const envelope = decodeProof(header);
    expect(Object.keys(envelope.presentation).sort()).toEqual([
      "nullifier",
      "proof",
      "request_hash",
      "root",
      "type",
    ]);
    expect(envelope.presentation.root).toBe(root.root);
    const wire = Buffer.from(header, "base64").toString("utf8").toLowerCase();
    const identifiers = [
      buyer.accountId,
      buyer.agentId,
      buyer.orgId,
      buyer.sessionId,
      buyer.accountAddress.slice(2),
      buyer.spendKeyAddress.slice(2),
      (buyer.agent.proofs.identityCommitment as Hex).slice(2),
      (buyer.proofSecret as Hex).slice(2),
    ];
    for (const id of identifiers) expect(wire).not.toContain(id.toLowerCase());

    // The nullifier is a per-seller pseudonym: stable at seller A, different at seller B.
    const again = await buyer.agent.fetchWithPayment(urlA("/credentials"));
    expect(again.response.status).toBe(200);
    expect(decodeProof(sellerA.log.at(-1)?.proof as string).request.nonce).not.toBe(envelope.request.nonce);
    expect(again.nullifier).toBe(first.nullifier);
    const elsewhere = await buyer.agent.fetchWithPayment(urlB("/credentials"));
    expect(elsewhere.response.status).toBe(200);
    expect(elsewhere.nullifier).toMatch(/^0x[0-9a-f]{64}$/);
    expect(elsewhere.nullifier).not.toBe(first.nullifier);
    stats.scenario(
      "a",
      "Agent credentials",
      "Owner-signed widening (unsigned: `owner_signature_required`); root valid in the registry; `verifiedCompany() + canPayPerTx(1.00)` → 200; the presentation carries no account, agent, org, address or commitment; nullifier stable per seller, different across sellers",
    );
  });

  it("refuses locally when the principal is an individual, not a verified company", async () => {
    const solo = await newAgent("kya-individual", { kind: "individual" });
    await enableProofs(solo, ["principal", "limits"]);
    await publishProofRoot(stack);
    const witness = await solo.agent.proofs.witness(solo.accountId);
    expect(witness.attributes.principal_verification).toBe("1"); // a verified individual

    const before = sellerA.log.length;
    const error = await expectProofError(solo.agent.fetchWithPayment(urlA("/credentials")), "unsatisfiable");
    expect(error.attributes).toEqual(["principal_verification"]);
    // Nothing was proved or sent: the seller only issued its challenge.
    expect(sellerA.log.slice(before).map((r) => [r.status, r.proof])).toEqual([[401, null]]);
    stats.scenario(
      "a",
      "Agent credentials (individual)",
      "An individual's agent is refused by its own SDK (`unsatisfiable`, `principal_verification`) before proving; the seller sees only its challenge",
    );
  });

  it("is refused by a verifier asking for a larger anonymity set than the tree has", async () => {
    const buyer = await credentialed();
    const root = await publishProofRoot(stack);
    sellerA.route("/crowd-exact", { require: [verifiedCompany()], minAnonymitySet: root.leaf_count });
    sellerA.route("/crowd-over", { require: [verifiedCompany()], minAnonymitySet: root.leaf_count + 1 });

    const exact = await buyer.agent.fetchWithPayment(urlA("/crowd-exact"));
    expect(exact.response.status).toBe(200);
    const error = await expectProofError(buyer.agent.fetchWithPayment(urlA("/crowd-over")), "proof_rejected");
    expect(error.verifierReason).toBe("anonymity_set_too_small");
    stats.scenario(
      "a",
      "Anonymity set",
      `A root of ${root.leaf_count} leaves satisfies \`min_anonymity_set = ${root.leaf_count}\`; one more is refused with \`anonymity_set_too_small\``,
    );
  });
});

describe("private reputation", () => {
  it("proves a track record and refuses over-claims", { timeout: 240_000 }, async () => {
    const escrow = stack.sim.contracts.escrow as Address;
    const worker = await newAgent("rep-worker", {
      fund: usdc("50"),
      scope: { allowed_contracts: [escrow] },
    });
    const client = await newAgent("rep-client", {
      fund: usdc("200"),
      scope: { allowed_contracts: [escrow] },
    });

    // Two settled payments by the worker.
    for (const n of [1, 2]) {
      const payment = await worker.agent.pay(
        { to: randomAccount().address, amount: "1.00", memo: `supplies ${n}` },
        { waitForSettlement: true },
      );
      expect(payment.status).toBe("settled");
    }
    // An escrow released to the worker as payee.
    const job = await client.agent.createEscrow(
      {
        payee: { agentId: worker.agentId },
        amount: "10.00",
        expiresAt: inDays(2),
        terms: "Label 500 images",
      },
      { waitForSettlement: true },
    );
    expect((await client.agent.releaseEscrow(job.id, { waitForSettlement: true })).status).toBe("released");
    // A dispute the arbiter resolves entirely for the worker: the client lost it.
    const arbiter = randomAccount();
    const disputed = await client.agent.createEscrow(
      { payee: { agentId: worker.agentId }, amount: "6.00", expiresAt: inDays(2), arbiter: arbiter.address },
      { waitForSettlement: true },
    );
    await worker.agent.disputeEscrow(disputed.id, "acceptance withheld", { waitForSettlement: true });
    const resolve = escrowResolveCall({
      escrow,
      escrowId: BigInt(disputed.onchain_id as string),
      payeeAmount: usdc("6"),
    });
    stack.sim.sendTransaction({ from: arbiter.address, to: resolve.to, data: resolve.data });
    await waitFor(
      stack,
      async () => (await client.agent.escrows.retrieve(disputed.id)).status === "resolved",
      "dispute resolved by the arbiter",
    );

    await enableProofs(worker, ["reputation", "account_age"]);
    await enableProofs(client, ["reputation"]);
    await publishProofRoot(stack);
    const attested = (await worker.agent.proofs.witness(worker.accountId)).attributes;
    expect(attested).toMatchObject({ payments_settled: "2", escrows_completed: "1", disputes_lost: "0" });
    expect((await client.agent.proofs.witness(client.accountId)).attributes.disputes_lost).toBe("1");

    sellerA.route("/hire", {
      require: [
        reputation({ escrowsCompleted: 1, disputesLostAtMost: 0, paymentsSettled: 2 }),
        accountOlderThan(0),
      ],
    });
    const hired = await worker.agent.fetchWithPayment(urlA("/hire"));
    expect(hired.response.status).toBe(200);
    expect(hired.proofPresented).toBe(true);

    // Over-claims are refused by the agent's own SDK before proving.
    sellerA.route("/hire-veteran", { require: [reputation({ escrowsCompleted: 2 })] });
    sellerA.route("/hire-busy", { require: [reputation({ paymentsSettled: 3 })] });
    sellerA.route("/hire-seasoned", { require: [accountOlderThan(30)] });
    for (const [path, attribute] of [
      ["/hire-veteran", "escrows_completed"],
      ["/hire-busy", "payments_settled"],
      ["/hire-seasoned", "account_created_on"],
    ] as const) {
      const error = await expectProofError(worker.agent.fetchWithPayment(urlA(path)), "unsatisfiable");
      expect(error.attributes).toEqual([attribute]);
    }
    // The client lost a dispute: it cannot claim a clean record.
    sellerA.route("/clean-record", { require: [reputation({ disputesLostAtMost: 0 })] });
    const lost = await expectProofError(
      client.agent.fetchWithPayment(urlA("/clean-record")),
      "unsatisfiable",
    );
    expect(lost.attributes).toEqual(["disputes_lost"]);

    await assertGlobalInvariants(stack, "reputation history");
    stats.scenario(
      "b",
      "Private reputation",
      "2 settled payments, an escrow released to the agent, a dispute resolved in its favour; `reputation({ escrowsCompleted: 1, disputesLostAtMost: 0, paymentsSettled: 2 }) + accountOlderThan(0)` → 200; over-claims (2 escrows, 3 payments, 30 days) and the losing party's clean-record claim refused (`unsatisfiable`)",
    );
  });
});

describe("proof of funds and reservations", () => {
  it(
    "proves a whole-dollar balance and funds reserved for one seller only",
    { timeout: 240_000 },
    async () => {
      const agent = await newAgent("pof-agent", { fund: usdc("150.75") });
      await enableProofs(agent, ["principal", "balance", "reservations"]);
      await publishProofRoot(stack);

      // Balances are attested floored to whole dollars.
      sellerA.route("/funds-150", { require: [balanceAtLeast("150.00")] });
      sellerA.route("/funds-150.75", { require: [balanceAtLeast("150.75")] });
      expect((await agent.agent.fetchWithPayment(urlA("/funds-150"))).response.status).toBe(200);
      const floored = await expectProofError(
        agent.agent.fetchWithPayment(urlA("/funds-150.75")),
        "unsatisfiable",
      );
      expect(floored.attributes).toEqual(["balance"]);

      // The SDK never reserves on its own.
      const none = await expectProofError(agent.agent.fetchWithPayment(urlA("/bid")), "reservation_required");
      expect(none.reservationNeeded).toMatchObject({ amount: "25.00", scope: SELLER_A });

      // Reserve $25 for seller A: a ledger hold, provable from the next root.
      const before = await available(agent);
      await stack.pauseDriver(); // hold the next root back to observe the pending state
      let reservationId: string;
      try {
        const reservation = await agent.agent.proofs.reserve({
          amount: "25.00",
          scope: SELLER_A,
          forSeconds: 3600,
        });
        reservationId = reservation.id;
        stats.reservations.created++;
        expect(reservation).toMatchObject({
          status: "pending",
          amount: { amount: "25.00", asset: "USDC" },
          scope_tag: scopeTagOf(SELLER_A).toString(),
        });
        expect(await available(agent)).toEqual({
          available: before.available - usdc("25"),
          reserved: before.reserved + usdc("25"),
        });
        await expectProofError(agent.agent.fetchWithPayment(urlA("/bid")), "reservation_pending");
      } finally {
        stack.resumeDriver();
      }
      await publishProofRoot(stack);
      const active = await waitFor(
        stack,
        async () => {
          const r = await agent.agent.proofs.retrieveReservation(reservationId);
          return r.status === "active" ? r : undefined;
        },
        "reservation active",
      );
      expect(active.included_in_epoch).not.toBeNull();

      const bid = await agent.agent.fetchWithPayment(urlA("/bid"));
      expect(bid.response.status).toBe(200);
      // The same reservation proves nothing to seller B (its scope tag differs).
      const other = await expectProofError(
        agent.agent.fetchWithPayment(urlB("/bid")),
        "reservation_required",
      );
      expect(other.reservationNeeded?.scope).toBe(SELLER_B);
      // The held funds are out of the attested balance.
      await expectProofError(agent.agent.fetchWithPayment(urlA("/funds-150")), "unsatisfiable");

      // The owner releases early (owner-signed): the hold is voided and every root holding it revoked.
      const prepared = await prepare(agent, urlA("/bid"));
      const lastHolding = BigInt(((await latestProofRoot(stack)) as { epoch: string }).epoch);
      const released = await agent.principal.proofs.releaseReservation(reservationId);
      expect(released.status).toBe("released");
      stats.reservations.released++;
      expect(await available(agent)).toEqual(before);
      await waitForRootStatus(stack, prepared.presentation.root, "revoked");
      const holding = (await listProofRoots(stack)).filter(
        (r) =>
          BigInt(r.epoch) >= BigInt(active.included_in_epoch as string) && BigInt(r.epoch) <= lastHolding,
      );
      expect(holding.length).toBeGreaterThan(0);
      for (const root of holding) {
        expect(root.status).toBe("revoked");
        expect(await registryRoot(stack, root.root)).toMatchObject({ revoked: true, valid: false });
      }
      expect(await present(urlA("/bid"), prepared.header)).toEqual({ status: 401, reason: "root_revoked" });
      await expectProofError(agent.agent.fetchWithPayment(urlA("/bid")), "reservation_required");

      // Expiry: the world clock passes the reservation's end and the hold is voided.
      const short = await agent.agent.proofs.reserve({ amount: "10.00", scope: SELLER_A, forSeconds: 90 });
      stats.reservations.created++;
      expect((await available(agent)).available).toBe(before.available - usdc("10"));
      stack.clock.advance(120_000);
      await waitFor(
        stack,
        async () => (await available(agent)).available === before.available,
        "expired hold voided",
      );
      expect((await agent.agent.proofs.retrieveReservation(short.id)).status).toBe("expired");
      expect(await available(agent)).toEqual(before);
      stats.reservations.expired++;

      await assertGlobalInvariants(stack, "proof-of-funds reservations");
      stats.scenario(
        "c",
        "Proof of funds",
        "$150.75 funded: `balanceAtLeast(150.00)` → 200, `150.75` refused (whole dollars); $25 reserved for seller A (available −$25, `reservation_pending` until the next root) proves `reservedFor(25.00, 10 min)` to A only (B: `reservation_required`); owner release voids the hold, revokes every root holding it (API and registry) and a prepared presentation gets `root_revoked`; a 90 s reservation expires with the world clock and its hold is voided",
      );
    },
  );
});

describe("disclosure control", () => {
  it("narrowing applies at once and revokes roots that disclosed more", async () => {
    const agent = await newAgent("disclose", { fund: usdc("40") });
    await enableProofs(agent, ["principal", "limits", "balance"]);
    await publishProofRoot(stack);
    sellerA.route("/funds-40", { require: [balanceAtLeast("40.00")] });
    expect((await agent.agent.fetchWithPayment(urlA("/funds-40"))).response.status).toBe(200);
    const prepared = await prepare(agent, urlA("/funds-40"));

    // Narrowing needs only the API key (this client has no owner key).
    const apiKeyOnly = new PrincipalClient({
      baseUrl: stack.apiUrl,
      apiKey: agent.apiKey,
      chainId: stack.chainId,
    });
    await stack.pauseDriver(); // before any new root: the narrowing is already served
    try {
      const narrowed = await apiKeyOnly.proofs.configure(agent.agentId, {
        enabled: true,
        disclose: ["principal", "limits"],
      });
      expect(narrowed.disclose).toEqual(["principal", "limits"]);
      const notReady = await refusal(stats, agent.agent.proofs.witness(agent.accountId));
      expect(notReady.code).toBe("invalid_state");
      expect(notReady.extensions).toMatchObject({ reason: "proof_not_ready" });
    } finally {
      stack.resumeDriver();
    }
    await waitForRootStatus(stack, prepared.presentation.root, "revoked");
    expect(await registryRoot(stack, prepared.presentation.root)).toMatchObject({
      revoked: true,
      valid: false,
    });
    expect(await present(urlA("/funds-40"), prepared.header)).toEqual({
      status: 401,
      reason: "root_revoked",
    });

    const undisclosed = await expectProofError(
      agent.agent.fetchWithPayment(urlA("/funds-40")),
      "undisclosed",
    );
    expect(undisclosed.undisclosedClasses).toEqual(["balance"]);
    expect((await agent.agent.fetchWithPayment(urlA("/credentials"))).response.status).toBe(200);
    stats.scenario(
      "d",
      "Disclosure control (narrowing)",
      "Removing `balance` with the API key alone: no witness is served before the new root (`proof_not_ready`), the wider roots are revoked (API and registry, `root_revoked` at the gate), a balance proof is refused (`undisclosed`), credentials still prove",
    );
  });

  it("freezing an agent revokes its roots and its witness is refused", async () => {
    const agent = await newAgent("frozen");
    await enableProofs(agent, ["principal", "limits"]);
    const root = await publishProofRoot(stack);
    expect((await agent.agent.fetchWithPayment(urlA("/credentials"))).response.status).toBe(200);
    const prepared = await prepare(agent, urlA("/credentials"));

    await agent.principal.agents.freeze(agent.agentId, { reason: "incident drill" });
    await waitForRootStatus(stack, prepared.presentation.root, "revoked");
    expect(await registryRoot(stack, prepared.presentation.root)).toMatchObject({
      revoked: true,
      valid: false,
    });
    const frozen = await refusal(stats, agent.agent.fetchWithPayment(urlA("/credentials")));
    expect(frozen.code).toBe("agent_frozen");
    expect(await present(urlA("/credentials"), prepared.header)).toEqual({
      status: 401,
      reason: "root_revoked",
    });
    const after = (await latestProofRoot(stack)) as { leaf_count: number };
    expect(after.leaf_count).toBeLessThan(root.leaf_count); // the frozen agent left the tree
    stats.scenario(
      "d",
      "Disclosure control (freeze)",
      "Freezing the agent publishes a root without it, revokes the older roots (API and registry; `root_revoked` at the gate) and its witness is refused (`agent_frozen`)",
    );
  });
});

describe("proof and payment", () => {
  it("answers the proof challenge, then pays, in one fetchWithPayment call", async () => {
    const buyer = await newAgent("premium-buyer", { fund: usdc("20") });
    await enableProofs(buyer, ["principal", "limits"]);
    await publishProofRoot(stack);
    await buyer.agent.pay(
      { to: buyer.spendKeyAddress, amount: "1.00", memo: "float" },
      { waitForSettlement: true },
    );
    await waitFor(stack, async () => (await buyer.agent.balance()).spend_float === "1.00", "float funded");

    sellerA.route("/premium", { require: [verifiedCompany(), canPayPerTx("0.05")], price: "0.05" });
    const proved = stats.generated;
    const from = sellerA.log.length;
    const result = await buyer.agent.fetchWithPayment(urlA("/premium"));
    expect(result.response.status).toBe(200);
    expect(result).toMatchObject({ paid: true, amount: "0.05", proofPresented: true });
    expect(result.nullifier).toMatch(/^0x[0-9a-f]{64}$/);
    expect(readPaymentResponse(result.response)?.success).toBe(true);
    expect(stats.generated - proved).toBe(1); // proved once; the paid retry reused the proof

    // 401 (proof) → 402 (payment; the proof verified but not used up) → 200 with both.
    const seen = sellerA.log.slice(from);
    expect(seen.map((r) => [r.status, r.proof !== null, r.paid])).toEqual([
      [401, false, false],
      [402, true, false],
      [200, true, true],
    ]);
    expect(seen[2]?.proof).toBe(seen[1]?.proof);
    expect(seen[2]?.nullifier).toBe(result.nullifier);

    await waitFor(
      stack,
      async () => usdc((await buyer.agent.balance()).spend_float) === usdc("0.95"),
      "float debited",
    );
    await assertGlobalInvariants(stack, "proof + x402");
    stats.scenario(
      "e",
      "Proof + payment",
      "`fetchWithPayment` answers 401 (proof) then 402 (x402 $0.05) in one call; one proof, the same `AGENT-PROOF` on the paid retry; settled; ledger and reconciliation invariants hold",
    );
  });
});

describe("replay and tampering", () => {
  it("refuses a replayed AGENT-PROOF header and an altered request", async () => {
    const buyer = await credentialed();
    const url = urlA("/credentials");
    const challenge = await fetchImpl(url);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe(`AgentProof realm="${SELLER_A}"`);
    const answer = await buyer.agent.proofs.answer(challenge.headers.get(PROOF_HEADERS.required) as string);

    const accepted = await fetchImpl(url, { headers: { [PROOF_HEADERS.proof]: answer.header } });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get(PROOF_HEADERS.response)).toBeTruthy();
    expect(await present(url, answer.header)).toEqual({ status: 401, reason: "nonce_reused" });

    // A looser bound in the echoed request: the gate's HMAC nonce no longer matches.
    const loosened: ProofRequest = {
      ...answer.request,
      constraints: { ...answer.request.constraints, per_tx_limit: { min: "0.01" } },
    };
    const tampered = encodeProof({ request: loosened, presentation: answer.presentation });
    expect(await present(url, tampered)).toEqual({ status: 401, reason: "nonce_invalid" });
    // Seller A's proof relayed to seller B.
    expect(await present(urlB("/credentials"), answer.header)).toEqual({
      status: 401,
      reason: "nonce_invalid",
    });

    // Agent Bank's stateless verifier (no nonce state): the proof binds the exact request.
    const verify = async (request: ProofRequest, presentation: ProofPresentation) => {
      const result = await buyer.agent.proofs.verify(request, presentation);
      stats.recordApiVerification(result.valid, result.reason);
      return result;
    };
    expect(await verify(answer.request, answer.presentation)).toMatchObject({
      valid: true,
      nullifier: answer.presentation.nullifier,
      root_status: "published",
    });
    expect(await verify(loosened, answer.presentation)).toMatchObject({
      valid: false,
      reason: "request_hash_mismatch",
    });
    expect(
      await verify(loosened, { ...answer.presentation, request_hash: requestHash(loosened) }),
    ).toMatchObject({
      valid: false,
      reason: "invalid_proof",
    });
    const forged = `0x${(BigInt(answer.presentation.nullifier) ^ 1n).toString(16).padStart(64, "0")}` as Hex;
    expect(await verify(answer.request, { ...answer.presentation, nullifier: forged })).toMatchObject({
      valid: false,
      reason: "invalid_proof",
    });
    stats.scenario(
      "f",
      "Replay and tampering",
      "Replayed `AGENT-PROOF` → `nonce_reused`; a loosened bound → `nonce_invalid`; relayed to another seller → `nonce_invalid`; `POST /v1/proofs/verify`: original valid, altered request `request_hash_mismatch`, re-hashed `invalid_proof`, forged nullifier `invalid_proof`",
    );
  });
});

describe("timings", () => {
  it(`proves and verifies ${TIMING_RUNS} more presentations`, async () => {
    const buyer = await credentialed();
    for (let i = 0; i < TIMING_RUNS; i++) {
      const result = await buyer.agent.fetchWithPayment(urlB("/credentials"));
      expect(result.response.status).toBe(200);
    }
  });
});
