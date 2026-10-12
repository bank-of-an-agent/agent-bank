import { AgentBankError, signInternalRequest, unixSeconds, verifyInternalRequest } from "@agentbank/core";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpCosignerClient } from "../src/cosigner/http-client";
import { unavailableCosigner } from "../src/cosigner/unavailable";
import type { Reconciler } from "../src/http/internal";
import { call, createHarness, type Harness } from "./support/harness";

const SECRET = "cosigner-test-secret-0123456789abcdef";

describe("HttpCosignerClient (fail closed)", () => {
  let server: Server;
  let url: string;
  let handler: (req: IncomingMessage, body: string, res: ServerResponse) => void = () => undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, body, res));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = (timeoutMs = 500) => new HttpCosignerClient({ url, sharedSecret: SECRET, timeoutMs });
  const decision = {
    id: "dec_1",
    outcome: "allow",
    rule_hits: [],
    approvers_required: 0,
    policy_version: 1,
    evaluated_at: "2026-10-11T12:00:00.000Z",
  };
  const evaluateInput = {
    org_id: "org_1",
    agent_id: "agt_1",
    account_id: "acct_1",
    account_address: "0x1111111111111111111111111111111111111111",
    chain_id: 1337,
    intent: { kind: "transfer" as const, amount: "1000000", asset: "USDC" as const, counterparty: {} },
  };

  it("signs every request with the internal HMAC scheme", async () => {
    let verified = false;
    handler = (req, body, res) => {
      verifyInternalRequest(SECRET, req.headers.authorization, req.method ?? "", req.url ?? "", body);
      verified = true;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(decision));
    };
    const result = await client().evaluate(evaluateInput);
    expect(result.outcome).toBe("allow");
    expect(verified).toBe(true);
  });

  it("maps timeouts, 5xx, auth failures and malformed answers to cosigner_unavailable", async () => {
    const cases: Array<(res: ServerResponse) => void> = [
      () => undefined, // never answers → timeout
      (res) => res.writeHead(500).end("boom"),
      (res) =>
        res
          .writeHead(401, { "content-type": "application/problem+json" })
          .end(JSON.stringify({ code: "unauthorized" })),
      (res) =>
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ outcome: "maybe" })),
      (res) => res.writeHead(200).end("not json"),
    ];
    for (const respond of cases) {
      handler = (_req, _body, res) => respond(res);
      await expect(client(200).evaluate(evaluateInput)).rejects.toMatchObject({
        code: "cosigner_unavailable",
        status: 503,
      });
    }
    const unreachable = new HttpCosignerClient({
      url: "http://127.0.0.1:1",
      sharedSecret: SECRET,
      timeoutMs: 200,
    });
    await expect(unreachable.health()).rejects.toMatchObject({ code: "cosigner_unavailable" });
  });

  it("passes a co-signer refusal through", async () => {
    handler = (_req, _body, res) =>
      res.writeHead(403, { "content-type": "application/problem+json" }).end(
        JSON.stringify({
          type: "urn:agentbank:problem:owner_signature_required",
          title: "x",
          status: 403,
          code: "owner_signature_required",
          detail: "loosening needs the owner",
        }),
      );
    await expect(
      client().putPolicy({
        org_id: "org_1",
        agent_id: "agt_1",
        chain_id: 1337,
        owner_address: "0x1111111111111111111111111111111111111111",
        policy: { asset: "USDC", limits: {}, counterparties: { mode: "open" } },
      }),
    ).rejects.toMatchObject({ code: "owner_signature_required", message: "loosening needs the owner" });
  });

  it("refuses everything without COSIGNER_URL", async () => {
    await expect(unavailableCosigner.cosign({} as never)).rejects.toBeInstanceOf(AgentBankError);
    await expect(unavailableCosigner.evaluate({} as never)).rejects.toMatchObject({
      code: "cosigner_unavailable",
    });
  });
});

describe("internal routes for the indexer", () => {
  const INTERNAL_SECRET = "internal-api-secret-0123456789abcdef0123";
  let h: Harness;
  const calls: string[] = [];
  const reconciler: Reconciler = {
    watchlist: async () => {
      calls.push("watchlist");
      return {
        chain_id: 1337,
        usdc: "0x5dc0000000000000000000000000000000005dc0",
        addresses: [],
        version: "v1",
      };
    },
    ingest: async (req) => {
      calls.push("ingest");
      return {
        results: req.events.map((e) => ({ event_id: e.id, status: "ignored", entry_id: null, ref: null })),
      };
    },
    reorg: async () => ({ reversed_entries: 0, reopened: [] }),
    expectedBalances: async (req) => ({
      balances: req.addresses.map((address) => ({ address, expected: "0" })),
    }),
    report: async () => ({ ok: true }),
  };

  beforeAll(async () => {
    h = await createHarness({ config: { INTERNAL_API_SHARED_SECRET: INTERNAL_SECRET } });
    h.deps.reconciler = reconciler;
  });
  afterAll(async () => h.close());

  function signed(method: string, path: string, body = "") {
    return {
      authorization: signInternalRequest(INTERNAL_SECRET, method, path, body, unixSeconds(h.clock.now())),
      ...(body ? { "content-type": "application/json" } : {}),
    };
  }

  it("refuses requests without a valid HMAC", async () => {
    const none = await h.app.inject({ method: "GET", url: "/internal/v1/watchlist" });
    expect(none.statusCode).toBe(401);
    const wrong = await h.app.inject({
      method: "GET",
      url: "/internal/v1/watchlist",
      headers: {
        authorization: signInternalRequest(
          "another-secret-0123456789abcdef",
          "GET",
          "/internal/v1/watchlist",
          "",
          unixSeconds(h.clock.now()),
        ),
      },
    });
    expect(wrong.statusCode).toBe(401);
    const stale = await h.app.inject({
      method: "GET",
      url: "/internal/v1/watchlist",
      headers: {
        authorization: signInternalRequest(
          INTERNAL_SECRET,
          "GET",
          "/internal/v1/watchlist",
          "",
          unixSeconds(h.clock.now()) - 3600,
        ),
      },
    });
    expect(stale.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("delegates authenticated requests to the reconciler", async () => {
    const watch = await h.app.inject({
      method: "GET",
      url: "/internal/v1/watchlist",
      headers: signed("GET", "/internal/v1/watchlist"),
    });
    expect(watch.statusCode).toBe(200);
    expect(JSON.parse(watch.body).version).toBe("v1");
    const body = JSON.stringify({
      chain_id: 1337,
      head_block: "12",
      finalized_block: "0",
      events: [
        {
          id: "1337:0xaa:0xbb:0",
          chain_id: 1337,
          block_number: "10",
          block_hash: `0x${"a".repeat(64)}`,
          block_timestamp: 1_790_000_000,
          tx_hash: `0x${"b".repeat(64)}`,
          log_index: 0,
          finality: "latest",
          contract: "0x5dc0000000000000000000000000000000005dc0",
          event_name: "Transfer",
          args: {
            from: "0x1111111111111111111111111111111111111111",
            to: "0x2222222222222222222222222222222222222222",
            value: "1",
          },
          user_op_hash: null,
        },
      ],
    });
    const ingest = await h.app.inject({
      method: "POST",
      url: "/internal/v1/chain-events",
      headers: signed("POST", "/internal/v1/chain-events", body),
      payload: body,
    });
    expect(ingest.statusCode).toBe(200);
    expect(JSON.parse(ingest.body).results[0].status).toBe("ignored");
    const tampered = await h.app.inject({
      method: "POST",
      url: "/internal/v1/chain-events",
      headers: signed("POST", "/internal/v1/chain-events", body),
      payload: body.replace('"value":"1"', '"value":"2"'),
    });
    expect(tampered.statusCode).toBe(401);
    const invalid = JSON.stringify({ chain_id: 1337 });
    const bad = await h.app.inject({
      method: "POST",
      url: "/internal/v1/chain-events",
      headers: signed("POST", "/internal/v1/chain-events", invalid),
      payload: invalid,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("is not part of the public OpenAPI document", async () => {
    const doc = await call(h.app, "GET", "/openapi.json");
    expect(Object.keys(doc.body.paths).some((p) => p.startsWith("/internal"))).toBe(false);
  });

  it("refuses everything when the secret is not configured", async () => {
    const plain = await createHarness();
    try {
      plain.deps.reconciler = reconciler;
      const res = await plain.app.inject({
        method: "GET",
        url: "/internal/v1/watchlist",
        headers: { authorization: signInternalRequest("", "GET", "/internal/v1/watchlist", "") },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await plain.close();
    }
  });
});
