/**
 * Smoke test of the built SDK (`pnpm --filter @agentbank/sdk build && pnpm --filter
 * @agentbank/sdk smoke:dist`): an `AgentClient` imported from `dist/` (ESM and CommonJS)
 * proves a request with the circuit files shipped in `dist/circuits/`, and the built
 * `proof-server` verifies both presentations. Only the test witness is built from source.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { buildWitness, ClaimsTree, identityCommitment, leafHash } from "@agentbank/proofs/tree";
import { DISCLOSURE_CLASSES, disclosureMask } from "@agentbank/proofs/schema";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type * as Sdk from "../src/index";
import type * as ProofServer from "../src/proof-server";

const dist = new URL("../dist/", import.meta.url);
// The bundled prover's only other candidate (`@agentbank/proofs`' artifacts/, resolved next to
// dist/) must not exist, so a passing run proves that dist/circuits/ is what was used.
if (!existsSync(new URL("circuits/agent_claims.zkey", dist)) || existsSync(new URL("../artifacts/", dist))) {
  throw new Error("expected the circuit files in dist/circuits/ only; run the build first");
}
const esm = (await import(new URL("index.js", dist).href)) as typeof Sdk;
const server = (await import(new URL("proof-server.js", dist).href)) as typeof ProofServer;
const cjs = createRequire(import.meta.url)(new URL("index.cjs", dist).pathname) as typeof Sdk;

const ACCOUNT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
const now = Math.floor(Date.now() / 1000);
const secret = esm.generateProofSecret();
const mask = disclosureMask(DISCLOSURE_CLASSES);
const attributes = {
  principal_verification: 2n,
  per_tx_limit: 25_000_000n,
  per_day_limit: 200_000_000n,
  balance: 1_250_000_000n,
  reserved_amount: 0n,
  reserved_until: 0n,
  reserved_for: 0n,
  account_created_on: 1_749_945_600n,
  payments_settled: 42n,
  volume_settled: 1_337_000_000n,
  escrows_completed: 3n,
  disputes_lost: 0n,
  counterparties: 7n,
};
const leaves = [leafHash(identityCommitment(secret), attributes, mask)];
for (let i = 1; i < 20; i++)
  leaves.push(leafHash(BigInt(i), { ...attributes, payments_settled: BigInt(i) }, mask));
const tree = new ClaimsTree(leaves);
const witness = buildWitness({
  tree,
  index: 0,
  attributes,
  disclosureMask: mask,
  accountId: ACCOUNT,
  chainId: 84532,
  registry: null,
  epoch: 1n,
  snapshotAt: now - 60,
  validUntil: now + 7_200,
});
const rootInfo = {
  epoch: 1n,
  snapshotAt: now - 60,
  publishedAt: now - 50,
  validUntil: now + 7_200,
  leafCount: tree.size,
  revoked: false,
};

async function proveWith(sdk: typeof Sdk, label: string): Promise<void> {
  const agent = new sdk.AgentClient({
    baseUrl: "http://agentbank.test",
    accountId: ACCOUNT,
    session: { id: "ses_01JABCDEFGHJKMNPQRSTVWXYZ0", signer: privateKeyToAccount(generatePrivateKey()) },
    proofSecret: secret,
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === `/v1/accounts/${ACCOUNT}/proofs/witness`) return Response.json(witness);
      return new Response("not found", { status: 404 });
    },
  });
  const request = server.createProofRequest({
    scope: "api.seller.example",
    require: [server.verifiedCompany(), server.canPayPerTx("5.00"), server.balanceAtLeast("1000.00")],
  });
  const started = Date.now();
  const presentation = await agent.proofs.prove(request);
  const result = await server.verifyPresentation({ request, presentation, rootInfo });
  if (!result.valid) throw new Error(`${label}: the built SDK's proof did not verify (${result.reason})`);
  console.log(`${label}: proved in ${Date.now() - started} ms, verified; nullifier ${result.nullifier}`);
  await sdk.releaseProofResources();
}

await proveWith(esm, "dist/index.js (ESM)");
await proveWith(cjs, "dist/index.cjs (CommonJS)");
await server.releaseProverResources();
