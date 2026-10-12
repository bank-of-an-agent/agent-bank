import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DISCLOSURE_CLASSES } from "@agentbank/core/api";
import { createProofGate as createBaseProofGate } from "@agentbank/proofs/http";
import express from "express";
import Fastify from "fastify";
import { Hono } from "hono";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentClient, generateProofSecret, releaseProofResources } from "../src";
import {
  apiRootResolver,
  canPayPerTx,
  createProofGate,
  decodeProof,
  decodeProofRequired,
  decodeProofResponse,
  encodeProof,
  expressProofGate,
  fastifyProofGate,
  honoProofGate,
  isTwoPhaseGate,
  nodeProofGate,
  proofOf,
  verifiedCompany,
  withProofGate,
  type ProofGateOptions,
  type ProofGateVariables,
  type RequestWithProof,
} from "../src/proof-server";
import { startFakeApi, type FakeApi } from "./helpers/fake-api";

const ACCT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SES = "ses_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SCOPE = "api.seller.example";
const GATE_KEY = "agentbank-sdk-test-gate-key-0123456789abcdef";
const sessionKey = privateKeyToAccount(generatePrivateKey());

let api: FakeApi;
/** One real `AGENT-PROOF` for a challenge of any gate with {@link gateOptions}: each gate (own replay cache) accepts it once. */
let proofHeader: string;
let nullifier: string;
const servers: Server[] = [];

const gateOptions = (): ProofGateOptions => ({
  scope: SCOPE,
  key: GATE_KEY,
  require: [verifiedCompany(), canPayPerTx("5.00")],
  rootResolver: apiRootResolver(api.url),
});

beforeAll(async () => {
  api = await startFakeApi({
    sessions: [{ id: SES, address: sessionKey.address, accountId: ACCT }],
    accounts: [{ id: ACCT }],
    proofs: { defaultSettings: { enabled: true, disclose: [...DISCLOSURE_CLASSES] } },
  });
  const agent = new AgentClient({
    baseUrl: api.url,
    accountId: ACCT,
    session: { id: SES, signer: sessionKey },
    proofSecret: generateProofSecret(),
  });
  await agent.proofs.enroll();
  const answer = await agent.proofs.answer(createProofGate(gateOptions()).createRequest());
  proofHeader = answer.header;
  nullifier = answer.presentation.nullifier;
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  await api.close();
  await releaseProofResources();
});

async function listen(handler: Parameters<typeof createServer>[1] | express.Express): Promise<string> {
  const server = createServer(handler as Parameters<typeof createServer>[1]);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The same proof with another nullifier: well-formed, but the Groth16 check fails. */
function tampered(): string {
  const envelope = decodeProof(proofHeader);
  return encodeProof({
    ...envelope,
    presentation: { ...envelope.presentation, nullifier: `0x${"01".repeat(32)}` },
  });
}

type Send = (headers?: Record<string, string>) => Promise<{
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}>;

/** What every adapter must do: challenge, accept once with the nullifier attached, refuse replays and junk. */
async function expectGateBehaviour(send: Send): Promise<void> {
  const challenge = await send();
  expect(challenge.status).toBe(401);
  expect(challenge.headers.get("www-authenticate")).toBe(`AgentProof realm="${SCOPE}"`);
  expect(challenge.headers.get("cache-control")).toBe("no-store");
  const request = decodeProofRequired(challenge.headers.get("agent-proof-required") ?? "");
  expect(request).toMatchObject({
    scope: SCOPE,
    constraints: { principal_verification: { min: "2", max: "2" } },
  });
  expect(challenge.body).toMatchObject({ error: "proof_required", reason: null, request });

  const accepted = await send({ "AGENT-PROOF": proofHeader });
  expect(accepted.status).toBe(200);
  expect(accepted.body).toEqual({ agent: nullifier });
  expect(decodeProofResponse(accepted.headers.get("agent-proof-response") ?? "")).toEqual({
    status: "accepted",
    nullifier,
  });

  const replay = await send({ "AGENT-PROOF": proofHeader });
  expect(replay.status).toBe(401);
  expect(replay.body.reason).toBe("nonce_reused");

  const junk = await send({ "AGENT-PROOF": "not-a-proof" });
  expect(junk.status).toBe(401);
  expect(junk.body.reason).toBe("malformed");
}

async function fromResponse(response: Response) {
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("proof gate adapters", () => {
  it("Web Request/Response: proofOf(request), invalid proofs and unreachable roots", async () => {
    const handler = withProofGate(createProofGate(gateOptions()), async (request: Request) =>
      Response.json({ agent: proofOf(request)?.nullifier }),
    );
    await expectGateBehaviour(async (headers = {}) =>
      fromResponse(await handler(new Request(`http://${SCOPE}/r`, { headers }))),
    );

    const fresh = withProofGate(createProofGate(gateOptions()), async () =>
      Response.json({ secret: "content" }),
    );
    const forged = await fresh(new Request(`http://${SCOPE}/r`, { headers: { "AGENT-PROOF": tampered() } }));
    expect(forged.status).toBe(401);
    expect(((await forged.json()) as { reason: string }).reason).toBe("invalid_proof");

    const offline = withProofGate(
      createProofGate({ ...gateOptions(), rootResolver: () => Promise.reject(new Error("rpc down")) }),
      async () => Response.json({ secret: "content" }),
    );
    const down = await offline(new Request(`http://${SCOPE}/r`, { headers: { "AGENT-PROOF": proofHeader } }));
    expect(down.status).toBe(502);
    const text = await down.text();
    expect(text).toContain("proof_verifier_unavailable");
    expect(text).not.toContain("rpc down");
  });

  it("Hono: c.get('agentProof') and proofOf(c)", async () => {
    const app = new Hono<{ Variables: ProofGateVariables }>();
    app.get("/r", honoProofGate(createProofGate(gateOptions())), (c) => {
      expect(proofOf(c)?.nullifier).toBe(c.get("agentProof").nullifier);
      return c.json({ agent: c.get("agentProof").nullifier });
    });
    await expectGateBehaviour(async (headers = {}) =>
      fromResponse(await app.request(`http://${SCOPE}/r`, { headers })),
    );
  });

  it("Express: req.agentProof", async () => {
    const app = express();
    app.get("/r", expressProofGate(createProofGate(gateOptions())), (req, res) => {
      expect(proofOf(req)).toBe((req as RequestWithProof).agentProof);
      res.json({ agent: (req as RequestWithProof).agentProof?.nullifier });
    });
    const base = await listen(app);
    await expectGateBehaviour(async (headers = {}) => fromResponse(await fetch(`${base}/r`, { headers })));
  });

  it("Node http: req.agentProof", async () => {
    const base = await listen(
      nodeProofGate(createProofGate(gateOptions()), (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ agent: (req as RequestWithProof).agentProof?.nullifier }));
      }),
    );
    await expectGateBehaviour(async (headers = {}) => fromResponse(await fetch(`${base}/r`, { headers })));
  });

  it("Fastify: preHandler hook, proofOf(request)", async () => {
    const app = Fastify();
    app.get("/r", { ...fastifyProofGate(createProofGate(gateOptions())) }, async (request) => ({
      agent: proofOf(request)?.nullifier,
    }));
    try {
      await expectGateBehaviour(async (headers = {}) => {
        const res = await app.inject({ method: "GET", url: "/r", headers });
        return {
          status: res.statusCode,
          headers: new Headers(res.headers as Record<string, string>),
          body: res.json() as Record<string, unknown>,
        };
      });
    } finally {
      await app.close();
    }
  });
});

describe("gate before a paywall", () => {
  /** Stands in for an x402 paywall: 402 without a payment header, 200 with one. */
  const paywalled = async (request: Request) =>
    request.headers.has("PAYMENT-SIGNATURE")
      ? Response.json({ agent: proofOf(request)?.nullifier })
      : Response.json({ x402Version: 2 }, { status: 402 });
  const send = (handler: (request: Request) => Promise<Response>, headers: Record<string, string>) =>
    handler(new Request(`http://${SCOPE}/r`, { headers }));

  it("uses a proof up only on the request that carries the payment", async () => {
    const handler = withProofGate(createProofGate(gateOptions()), paywalled, { beforePaywall: true });
    for (let i = 0; i < 2; i++) {
      const unpaid = await send(handler, { "AGENT-PROOF": proofHeader });
      expect(unpaid.status).toBe(402);
      expect(unpaid.headers.get("AGENT-PROOF-RESPONSE")).toBeNull();
    }
    const paid = await send(handler, { "AGENT-PROOF": proofHeader, "PAYMENT-SIGNATURE": "x" });
    expect(paid.status).toBe(200);
    expect(paid.headers.get("AGENT-PROOF-RESPONSE")).toBeTruthy();
    const again = await send(handler, { "AGENT-PROOF": proofHeader, "PAYMENT-SIGNATURE": "y" });
    expect(again.status).toBe(401);
    expect(((await again.json()) as { reason: string }).reason).toBe("nonce_reused");
    expect((await send(handler, {})).status).toBe(401);
  });

  it("with a gate that cannot defer (no peek/commit), the proof is used up on the 402", async () => {
    const base = createBaseProofGate(gateOptions());
    expect(isTwoPhaseGate(base)).toBe(false);
    const handler = withProofGate(base, paywalled, { beforePaywall: true });
    expect((await send(handler, { "AGENT-PROOF": proofHeader })).status).toBe(402);
    const paid = await send(handler, { "AGENT-PROOF": proofHeader, "PAYMENT-SIGNATURE": "x" });
    expect(paid.status).toBe(401);
  });

  it("createProofGate: peek leaves the nonce unused, commit and check use it up once", async () => {
    const gate = createProofGate(gateOptions());
    expect(isTwoPhaseGate(gate)).toBe(true);
    const headers = { "AGENT-PROOF": proofHeader };
    const first = await gate.peek(headers);
    const second = await gate.peek(headers);
    if (first.kind !== "verified" || second.kind !== "verified") throw new Error("expected verified");
    expect(first.nullifier).toBe(nullifier);
    expect(await gate.commit(first)).toBe(true);
    expect(await gate.commit(second)).toBe(false);
    expect((await gate.check(headers)).kind).toBe("proof-required");
    expect((await gate.peek(headers)).kind).toBe("proof-required");

    const strict = createProofGate(gateOptions());
    expect((await strict.check(headers)).kind).toBe("verified");
    const replay = await strict.check(headers);
    expect(replay.kind === "proof-required" && replay.reason).toBe("nonce_reused");
  });
});
