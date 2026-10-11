import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { contentDigest, parseSignatureInput, signRequest, verifyRequest } from "../src/http-signatures";
import { signWebhook, verifyWebhook } from "../src/webhooks";
import { ownerAuthorizationTypedData, verifyOwnerAuthorization } from "../src/eip712";
import { canonicalJson, canonicalKeccak } from "../src/canonical";
import { appendAudit, verifyAuditChain, type AuditRecord } from "../src/audit";

const session = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const NOW = 1_790_000_000;

function request(body = '{"amount":{"amount":"1.00","asset":"USDC"}}') {
  return {
    method: "POST",
    url: "http://localhost:8080/v1/payments",
    headers: { "content-type": "application/json", "idempotency-key": "idem-12345678" } as Record<
      string,
      string
    >,
    body,
  };
}

describe("HTTP message signatures (RFC 9421)", () => {
  const resolveKey = async (id: string) => (id === "ses_1" ? session.address : undefined);

  it("signs and verifies a request", async () => {
    const req = request();
    const signed = await signRequest(req, { keyId: "ses_1", signer: session, created: NOW, nonce: "n1" });
    expect(signed["signature-input"]).toContain('"@method" "@target-uri" "content-digest" "idempotency-key"');
    const verified = await verifyRequest(
      { ...req, headers: { ...req.headers, ...signed } },
      { resolveKey, now: NOW + 5 },
    );
    expect(verified.address).toBe(session.address);
    expect(verified.keyId).toBe("ses_1");
  });

  it("rejects a tampered body, wrong key, expiry, replay and unknown keys", async () => {
    const req = request();
    const signed = await signRequest(req, { keyId: "ses_1", signer: session, created: NOW, nonce: "n2" });
    const headers = { ...req.headers, ...signed };
    await expect(
      verifyRequest({ ...req, headers, body: '{"amount":"999"}' }, { resolveKey, now: NOW }),
    ).rejects.toThrow(/Content-Digest/);
    await expect(
      verifyRequest(
        { ...req, headers: { ...headers, "content-digest": contentDigest('{"x":1}') }, body: '{"x":1}' },
        {
          resolveKey,
          now: NOW,
        },
      ),
    ).rejects.toThrow(/session key/);
    await expect(verifyRequest({ ...req, headers }, { resolveKey, now: NOW + 1000 })).rejects.toThrow(
      /expired/,
    );
    await expect(
      verifyRequest({ ...req, headers }, { resolveKey: async () => other.address, now: NOW }),
    ).rejects.toThrow(/session key/);
    await expect(
      verifyRequest({ ...req, headers }, { resolveKey: async () => undefined, now: NOW }),
    ).rejects.toThrow(/Unknown key/);
    const seen = new Set<string>();
    const checkAndStoreNonce = async (k: string, n: string) => {
      const key = `${k}:${n}`;
      const was = seen.has(key);
      seen.add(key);
      return was;
    };
    await verifyRequest({ ...req, headers }, { resolveKey, now: NOW, checkAndStoreNonce });
    await expect(
      verifyRequest({ ...req, headers }, { resolveKey, now: NOW, checkAndStoreNonce }),
    ).rejects.toThrow(/nonce/);
  });

  it("requires covered headers and well-formed inputs", async () => {
    const req = request();
    const signed = await signRequest(req, { keyId: "ses_1", signer: session, created: NOW });
    const { "idempotency-key": _drop, ...withoutIdem } = req.headers;
    await expect(
      verifyRequest({ ...req, headers: { ...withoutIdem, ...signed } }, { resolveKey, now: NOW }),
    ).rejects.toThrow(/idempotency-key/);
    await expect(verifyRequest({ ...req, headers: req.headers }, { resolveKey, now: NOW })).rejects.toThrow(
      /Missing/,
    );
    expect(() => parseSignatureInput("garbage")).toThrow(/Malformed/);
    const parsed = parseSignatureInput(signed["signature-input"]);
    expect(parsed.params.alg).toBe("eip191-secp256k1");
  });

  it("signs GET requests without a body", async () => {
    const req = { method: "GET", url: "http://localhost:8080/v1/accounts/acct_1/balances?x=1", headers: {} };
    const signed = await signRequest(req, { keyId: "ses_1", signer: session, created: NOW });
    expect(signed["content-digest"]).toBeUndefined();
    await expect(verifyRequest({ ...req, headers: signed }, { resolveKey, now: NOW })).resolves.toMatchObject(
      {
        keyId: "ses_1",
      },
    );
  });
});

describe("webhooks", () => {
  it("signs and verifies with tolerance", () => {
    const header = signWebhook("whsec_test", '{"id":"evt_1"}', NOW);
    expect(verifyWebhook("whsec_test", '{"id":"evt_1"}', header, { now: NOW + 10 })).toBe(NOW);
    expect(() => verifyWebhook("whsec_test", '{"id":"evt_2"}', header, { now: NOW })).toThrow(/mismatch/);
    expect(() => verifyWebhook("whsec_other", '{"id":"evt_1"}', header, { now: NOW })).toThrow(/mismatch/);
    expect(() => verifyWebhook("whsec_test", '{"id":"evt_1"}', header, { now: NOW + 3600 })).toThrow(
      /tolerance/,
    );
    expect(() => verifyWebhook("whsec_test", "{}", undefined)).toThrow(/Missing/);
    expect(() => verifyWebhook("whsec_test", "{}", "v1=abc")).toThrow(/timestamp/);
  });
});

describe("owner authorizations (EIP-712)", () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const payload = { agent: "agt_1", limits: { per_day: "500.00" } };
  const base = {
    chainId: 84532,
    action: "policy.loosen" as const,
    subject: "agt_1",
    payload,
    issuedAt: NOW,
    expiresAt: NOW + 600,
  };

  it("verifies a valid owner signature", async () => {
    const signature = await owner.signTypedData(ownerAuthorizationTypedData(base));
    await expect(
      verifyOwnerAuthorization({
        ...base,
        owner: owner.address,
        signer: owner.address,
        signature,
        now: NOW + 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects altered payloads, other signers and long windows", async () => {
    const signature = await owner.signTypedData(ownerAuthorizationTypedData(base));
    await expect(
      verifyOwnerAuthorization({
        ...base,
        payload: { ...payload, limits: { per_day: "50000.00" } },
        owner: owner.address,
        signer: owner.address,
        signature,
        now: NOW,
      }),
    ).rejects.toThrow(/invalid/);
    await expect(
      verifyOwnerAuthorization({ ...base, owner: owner.address, signer: other.address, signature, now: NOW }),
    ).rejects.toThrow(/owner key/);
    await expect(
      verifyOwnerAuthorization({
        ...base,
        expiresAt: NOW + 7200,
        owner: owner.address,
        signer: owner.address,
        signature,
        now: NOW,
      }),
    ).rejects.toThrow(/15 minutes/);
    await expect(
      verifyOwnerAuthorization({
        ...base,
        owner: owner.address,
        signer: owner.address,
        signature,
        now: NOW + 601,
      }),
    ).rejects.toThrow(/expired/);
  });
});

describe("canonical JSON and audit chain", () => {
  it("is key-order independent and handles bigints", () => {
    expect(canonicalJson({ b: 1, a: [2n, { d: undefined, c: "x" }] })).toBe('{"a":["2",{"c":"x"}],"b":1}');
    expect(canonicalKeccak({ a: 1, b: 2 })).toBe(canonicalKeccak({ b: 2, a: 1 }));
    expect(canonicalJson(new Date("2026-10-11T00:00:00Z"))).toBe('"2026-10-11T00:00:00.000Z"');
    expect(() => canonicalJson(Number.NaN)).toThrow();
  });

  it("detects tampering anywhere in the chain", () => {
    const records: AuditRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push(
        appendAudit(records.at(-1), {
          at: `2026-10-11T00:00:0${i}Z`,
          actor: "cosigner",
          action: "cosign",
          subject: `pay_${i}`,
          payload: { i },
        }),
      );
    }
    expect(verifyAuditChain(records)).toBe(-1);
    const tampered = records.map((r) => ({ ...r }));
    tampered[4] = { ...tampered[4]!, payload: { i: 999 } };
    expect(verifyAuditChain(tampered)).toBe(4);
    expect(verifyAuditChain(records.filter((_, i) => i !== 6))).toBe(6);
  });
});
