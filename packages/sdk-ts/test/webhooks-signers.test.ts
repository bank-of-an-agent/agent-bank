import { readFileSync } from "node:fs";
import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AuthenticationError,
  generateSessionKey,
  generateSpendKey,
  InvalidRequestError,
  OPERATION_HASH_SIGNING,
  parseWebhookEvent,
  signerFromPrivateKey,
  signOperationHash,
  signWebhook,
  verifyWebhook,
  type OwnerSigner,
  type SessionSigner,
  type SpendSigner,
  type WebhookEvent,
} from "../src";

const vectors = JSON.parse(
  readFileSync(new URL("../../core/test/vectors/vectors.json", import.meta.url), "utf8"),
) as {
  webhook: { secret: string; body: string; timestamp: number; header: string };
};

describe("webhooks", () => {
  it("verifies the cross-language vector and parses a typed event", () => {
    const w = vectors.webhook;
    expect(verifyWebhook(w.secret, w.body, w.header, { now: w.timestamp + 10 })).toBe(w.timestamp);
    const event = parseWebhookEvent(
      { secret: w.secret, body: w.body, signature: w.header },
      { now: w.timestamp },
    );
    expect(event.type).toBe("payment.settled");
    if (event.type === "payment.settled") {
      expectTypeOf<typeof event.data.amount.amount>().toEqualTypeOf<string>();
      expect(event.data.id).toBe("pay_1");
    }
  });

  it("accepts raw bytes and rejects bad signatures, stale timestamps and non-events", () => {
    const secret = "whsec_test";
    const body = JSON.stringify({ id: "evt_1", type: "agent.frozen", data: { id: "agt_1" } });
    const header = signWebhook(secret, body);
    const event: WebhookEvent = parseWebhookEvent({
      secret,
      body: new TextEncoder().encode(body),
      signature: header,
    });
    expect(event.type).toBe("agent.frozen");
    expect(() => parseWebhookEvent({ secret: "whsec_other", body, signature: header })).toThrow(
      AuthenticationError,
    );
    expect(() => parseWebhookEvent({ secret, body, signature: undefined })).toThrow(AuthenticationError);
    const stale = signWebhook(secret, body, Math.floor(Date.now() / 1000) - 3600);
    expect(() => parseWebhookEvent({ secret, body, signature: stale })).toThrow(/tolerance/);
    const notEvent = JSON.stringify({ hello: "world" });
    expect(() =>
      parseWebhookEvent({ secret, body: notEvent, signature: signWebhook(secret, notEvent) }),
    ).toThrow(InvalidRequestError);
  });
});

describe("keys and signers", () => {
  it("generates keys whose private key is hidden from enumeration", () => {
    const key = generateSessionKey();
    expect(key.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(key.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.keys(key)).not.toContain("privateKey");
    expect(JSON.stringify(key)).not.toContain(key.privateKey.slice(2));
    expect(generateSpendKey().address).not.toBe(key.address);
    expect(signerFromPrivateKey(key.privateKey).address).toBe(key.address);
    expect(() => signerFromPrivateKey("0x1234")).toThrow(InvalidRequestError);
    expect(() => signerFromPrivateKey("0xnot-a-key-at-all")).not.toThrow(/not-a-key/);
  });

  it("signs operation hashes as EIP-191 over the raw 32 bytes (core OPERATION_HASH_SIGNING) and refuses anything else", async () => {
    expect(OPERATION_HASH_SIGNING).toBe("eip191-raw-bytes32");
    const account = privateKeyToAccount(generatePrivateKey());
    const hash = `0x${"11".repeat(32)}` as const;
    const signature = await signOperationHash(account, hash);
    expect(await verifyMessage({ address: account.address, message: { raw: hash }, signature })).toBe(true);
    expect(await verifyMessage({ address: account.address, message: hash, signature })).toBe(false);
    await expect(signOperationHash(account, "transfer everything")).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    await expect(signOperationHash(account, `0x${"11".repeat(33)}`)).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });

  it("accepts viem local accounts as session, spend and owner signers", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    expectTypeOf(account).toExtend<SessionSigner>();
    expectTypeOf(account).toExtend<SpendSigner>();
    expectTypeOf(account).toExtend<OwnerSigner>();
  });
});
