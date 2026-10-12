import { createInternalHandler } from "@agentbank/reconciliation";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { SimBank, usd } from "../../../packages/reconciliation/test/support/sim-bank";
import { HttpReconcilerTransport, Indexer, IndexerStore } from "../src";

const SECRET = "http-test-internal-secret-0123456789";

/** The API side: the reconciler's five routes on a real HTTP server that keeps the raw body. */
async function serve(bank: SimBank): Promise<{ app: FastifyInstance; url: string }> {
  const app = Fastify();
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) =>
    done(null, body),
  );
  const handler = createInternalHandler(bank.reconciler, { secret: SECRET, clock: bank.clock });
  app.all("/internal/v1/*", async (request, reply) => {
    const header = request.headers.authorization;
    const res = await handler({
      method: request.method,
      path: request.url.split("?")[0] ?? request.url,
      authorization: Array.isArray(header) ? header[0] : header,
      body: typeof request.body === "string" ? request.body : "",
    });
    return reply.code(res.status).header("content-type", res.contentType).send(res.body);
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { app, url: `http://127.0.0.1:${port}` };
}

describe("indexer → reconciler over HTTP (HMAC)", () => {
  let bank: SimBank;
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    await bank?.close();
  });

  it("indexes deposits, payments and a reorg through the internal API", async () => {
    bank = await SimBank.create();
    const served = await serve(bank);
    app = served.app;
    const now = () => Math.floor(bank.now().getTime() / 1000);
    const transport = new HttpReconcilerTransport({ baseUrl: served.url, secret: SECRET, now });
    const indexer = new Indexer({
      chain: bank.chain.gateway,
      transport,
      store: new IndexerStore(bank.indexerDb, bank.chain.chainId, () => bank.now()),
      startBlock: 0n,
      clock: bank.clock,
    });
    const org = await bank.createOrg();
    const a = await bank.createAccount(org);
    const b = await bank.createAccount(org);
    bank.faucet(a.address, usd(40));
    await indexer.catchUp();
    const p = await bank.pay(a, b.address, usd(15), { toAccount: b });
    await bank.flushRows();
    await indexer.catchUp();
    expect(await bank.paymentStatus(p.id)).toBe("settled");
    bank.chain.injectReorg(1);
    await indexer.catchUp();
    expect(bank.reconciler.stats().rebound).toBe(1);
    const check = await indexer.balanceCheck();
    expect(check?.mismatches).toEqual([]);

    // A wrong secret is refused by the API before anything is read.
    const forged = new HttpReconcilerTransport({
      baseUrl: served.url,
      secret: "not-the-secret-0123456789",
      now,
    });
    await expect(forged.watchlist()).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    // Responses are validated against the contract.
    await expect(
      transport.ingest({
        chain_id: bank.chain.chainId + 1,
        head_block: "1",
        finalized_block: "0",
        events: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
