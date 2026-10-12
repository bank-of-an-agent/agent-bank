/**
 * Cross-language test vectors for the SDKs (TypeScript and Python must agree
 * byte-for-byte). Deterministic: fixed keys, timestamps and nonces; ECDSA
 * signatures are RFC 6979 deterministic.
 *   pnpm --filter @agentbank/core exec tsx scripts/generate-vectors.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson, canonicalKeccak } from "../src/canonical";
import { ownerAuthorizationTypedData } from "../src/eip712";
import { contentDigest, signatureBase, signRequest, parseSignatureInput } from "../src/http-signatures";
import { signWebhook } from "../src/webhooks";

// Well-known Anvil dev keys (public test keys, never used for real funds).
const SESSION_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const OWNER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const session = privateKeyToAccount(SESSION_KEY);
const owner = privateKeyToAccount(OWNER_KEY);

const body = JSON.stringify({
  account_id: "acct_01JABCDEFGHJKMNPQRSTVWXYZ0",
  amount: { amount: "12.50", asset: "USDC" },
  to: { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
  memo: "dataset purchase",
});
const request = {
  method: "POST",
  url: "https://api.example.test/v1/payments",
  headers: { "content-type": "application/json", "idempotency-key": "idem-0001-0002" },
  body,
};
const signed = await signRequest(request, {
  keyId: "ses_01JABCDEFGHJKMNPQRSTVWXYZ0",
  signer: session,
  created: 1_790_000_000,
  lifetimeSeconds: 120,
  nonce: "bm9uY2Utdm-VjdG9y",
});
const base = signatureBase(
  { ...request, headers: { ...request.headers, ...signed } },
  parseSignatureInput(signed["signature-input"]).params,
);

const getRequest = {
  method: "GET",
  url: "https://api.example.test/v1/accounts/acct_01JABCDEFGHJKMNPQRSTVWXYZ0/balances",
  headers: {},
};
const signedGet = await signRequest(getRequest, {
  keyId: "ses_01JABCDEFGHJKMNPQRSTVWXYZ0",
  signer: session,
  created: 1_790_000_100,
  lifetimeSeconds: 60,
  nonce: "Z2V0LW5vbmNl",
});

const policyPayload = {
  agent: "agt_01JABCDEFGHJKMNPQRSTVWXYZ0",
  limits: { per_tx: "50.00", per_day: "500.00" },
  counterparties: { mode: "allowlist", x402_domains: ["api.example-data.com"] },
};
const typed = ownerAuthorizationTypedData({
  chainId: 84532,
  action: "policy.loosen",
  subject: "agt_01JABCDEFGHJKMNPQRSTVWXYZ0",
  payload: policyPayload,
  issuedAt: 1_790_000_000,
  expiresAt: 1_790_000_600,
});
const ownerSignature = await owner.signTypedData(typed);

const webhookBody = JSON.stringify({
  id: "evt_01JABCDEFGHJKMNPQRSTVWXYZ0",
  type: "payment.settled",
  data: { id: "pay_1" },
});

const vectors = {
  description:
    "Agent Bank cross-language vectors. Keys are public Anvil dev keys; never use them for real funds.",
  keys: {
    session_private_key: SESSION_KEY,
    session_address: session.address,
    owner_private_key: OWNER_KEY,
    owner_address: owner.address,
  },
  http_signature_post: {
    request,
    params: {
      key_id: "ses_01JABCDEFGHJKMNPQRSTVWXYZ0",
      created: 1_790_000_000,
      lifetime_seconds: 120,
      nonce: "bm9uY2Utdm-VjdG9y",
    },
    content_digest: contentDigest(body),
    signature_base: base,
    headers: signed,
  },
  http_signature_get: {
    request: getRequest,
    params: {
      key_id: "ses_01JABCDEFGHJKMNPQRSTVWXYZ0",
      created: 1_790_000_100,
      lifetime_seconds: 60,
      nonce: "Z2V0LW5vbmNl",
    },
    headers: signedGet,
  },
  canonical_json: {
    input: { b: 1, a: [2, { d: null, c: "x" }], e: "ü" },
    output: canonicalJson({ b: 1, a: [2, { d: null, c: "x" }], e: "ü" }),
  },
  owner_authorization: {
    chain_id: 84532,
    action: "policy.loosen",
    subject: "agt_01JABCDEFGHJKMNPQRSTVWXYZ0",
    payload: policyPayload,
    payload_canonical_json: canonicalJson(policyPayload),
    payload_hash: canonicalKeccak(policyPayload),
    issued_at: 1_790_000_000,
    expires_at: 1_790_000_600,
    signature: ownerSignature,
  },
  webhook: {
    secret: "whsec_test_vector",
    body: webhookBody,
    timestamp: 1_790_000_000,
    header: signWebhook("whsec_test_vector", webhookBody, 1_790_000_000),
  },
};

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../test/vectors/vectors.json");
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${out}`);
