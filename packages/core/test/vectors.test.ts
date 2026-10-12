import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalKeccak } from "../src/canonical";
import { ownerAuthorizationTypedData, verifyOwnerAuthorization } from "../src/eip712";
import { signRequest, verifyRequest } from "../src/http-signatures";
import { signWebhook } from "../src/webhooks";

/** The Python SDK runs the same vectors; both must agree byte-for-byte. */
const vectors = JSON.parse(readFileSync(new URL("./vectors/vectors.json", import.meta.url), "utf8"));

describe("cross-language vectors", () => {
  const session = privateKeyToAccount(vectors.keys.session_private_key);
  const owner = privateKeyToAccount(vectors.keys.owner_private_key);

  it("reproduces the POST request signature", async () => {
    const v = vectors.http_signature_post;
    const headers = await signRequest(v.request, {
      keyId: v.params.key_id,
      signer: session,
      created: v.params.created,
      lifetimeSeconds: v.params.lifetime_seconds,
      nonce: v.params.nonce,
    });
    expect(headers).toEqual(v.headers);
    await expect(
      verifyRequest(
        { ...v.request, headers: { ...v.request.headers, ...v.headers } },
        { resolveKey: async () => session.address, now: v.params.created + 1 },
      ),
    ).resolves.toMatchObject({ keyId: v.params.key_id });
  });

  it("reproduces the GET request signature", async () => {
    const v = vectors.http_signature_get;
    const headers = await signRequest(v.request, {
      keyId: v.params.key_id,
      signer: session,
      created: v.params.created,
      lifetimeSeconds: v.params.lifetime_seconds,
      nonce: v.params.nonce,
    });
    expect(headers).toEqual(v.headers);
  });

  it("reproduces canonical JSON, owner authorization and webhook signatures", async () => {
    expect(canonicalJson(vectors.canonical_json.input)).toBe(vectors.canonical_json.output);
    const oa = vectors.owner_authorization;
    expect(canonicalJson(oa.payload)).toBe(oa.payload_canonical_json);
    expect(canonicalKeccak(oa.payload)).toBe(oa.payload_hash);
    const typed = ownerAuthorizationTypedData({
      chainId: oa.chain_id,
      action: oa.action,
      subject: oa.subject,
      payload: oa.payload,
      issuedAt: oa.issued_at,
      expiresAt: oa.expires_at,
    });
    expect(await owner.signTypedData(typed)).toBe(oa.signature);
    await verifyOwnerAuthorization({
      chainId: oa.chain_id,
      action: oa.action,
      subject: oa.subject,
      payload: oa.payload,
      issuedAt: oa.issued_at,
      expiresAt: oa.expires_at,
      owner: owner.address,
      signer: owner.address,
      signature: oa.signature,
      now: oa.issued_at,
    });
    const w = vectors.webhook;
    expect(signWebhook(w.secret, w.body, w.timestamp)).toBe(w.header);
  });
});
