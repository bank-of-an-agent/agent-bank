import { readFileSync } from "node:fs";
import { verifyOwnerAuthorization } from "@agentbank/core";
import { recoverMessageAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentBankError,
  generateSessionKey,
  InvalidRequestError,
  ownerAuthorize,
  ownerPayloads,
  PermissionDeniedError,
  PrincipalClient,
} from "../src";
import { startFakeApi, type FakeApi } from "./helpers/fake-api";

const vectors = JSON.parse(
  readFileSync(new URL("../../core/test/vectors/vectors.json", import.meta.url), "utf8"),
) as {
  keys: { owner_private_key: `0x${string}`; owner_address: string };
  owner_authorization: {
    chain_id: number;
    action: "policy.loosen";
    subject: string;
    payload: unknown;
    issued_at: number;
    expires_at: number;
    signature: string;
  };
};

const owner = privateKeyToAccount(vectors.keys.owner_private_key);
const ACCT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
const AGENT = "agt_01JABCDEFGHJKMNPQRSTVWXYZ0";

let api: FakeApi;

beforeAll(async () => {
  api = await startFakeApi({ ownerAddress: owner.address, accounts: [{ id: ACCT }] });
});

afterAll(async () => {
  await api.close();
});

function principal(withOwner = true): PrincipalClient {
  return new PrincipalClient({
    baseUrl: api.url,
    apiKey: "abk_test_fake",
    ...(withOwner ? { owner } : {}),
    validateResponses: true,
  });
}

describe("ownerAuthorize", () => {
  it("reproduces the cross-language owner authorization vector", async () => {
    const v = vectors.owner_authorization;
    const auth = await ownerAuthorize(owner, {
      chainId: v.chain_id,
      action: v.action,
      subject: v.subject,
      payload: v.payload,
      issuedAt: v.issued_at,
      ttlSeconds: v.expires_at - v.issued_at,
    });
    expect(auth).toEqual({
      signer: vectors.keys.owner_address,
      signature: v.signature,
      issued_at: v.issued_at,
      expires_at: v.expires_at,
    });
  });

  it("produces authorizations core verifies, within the 15-minute window", async () => {
    const payload = { reason: "investigated" };
    const auth = await ownerAuthorize(owner, {
      chainId: 84532,
      ...ownerPayloads.agentUnfreeze(AGENT, "investigated"),
    });
    expect(auth.expires_at - auth.issued_at).toBe(600);
    await verifyOwnerAuthorization({
      chainId: 84532,
      action: "agent.unfreeze",
      subject: AGENT,
      payload,
      issuedAt: auth.issued_at,
      expiresAt: auth.expires_at,
      owner: owner.address,
      signer: auth.signer as `0x${string}`,
      signature: auth.signature as `0x${string}`,
    });
  });

  it("refuses long windows, unknown actions and mainnet chains", async () => {
    const base = { chainId: 84532, action: "policy.loosen" as const, subject: AGENT, payload: {} };
    await expect(ownerAuthorize(owner, { ...base, ttlSeconds: 901 })).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    await expect(ownerAuthorize(owner, { ...base, action: "withdraw.all" as never })).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    const mainnet = await ownerAuthorize(owner, { ...base, chainId: 8453 }).catch((e: unknown) => e);
    expect(mainnet).toBeInstanceOf(AgentBankError);
    expect((mainnet as AgentBankError).code).toBe("mainnet_locked");
  });
});

describe("PrincipalClient.grantSession", () => {
  it("creates the session with a verified owner authorization, installs it and signs the owner operation", async () => {
    const sessionKey = generateSessionKey();
    const { session, installOperation } = await principal().grantSession({
      accountId: ACCT,
      publicKey: sessionKey.address,
      scope: {
        max_per_tx: "25.00",
        max_per_day: "200.00",
        allowed_recipients: ["0x2222222222222222222222222222222222222222"],
      },
      ttlSeconds: 3600,
      waitForInstall: { intervalMs: 5 },
    });
    expect(session.status).toBe("active");
    expect(session.scope.asset).toBe("USDC");
    expect(Date.parse(session.expires_at) - Date.now()).toBeGreaterThan(3500_000);
    expect(installOperation?.status).toBe("succeeded");

    const create = api.requests.find((r) => r.method === "POST" && r.url === "/v1/sessions");
    const sent = JSON.parse(create?.body ?? "{}");
    expect(sent.owner_authorization.signer).toBe(owner.address);
    expect(sent.scope).toEqual(session.scope);

    const submit = api.requests.find(
      (r) => r.url === `/v1/owner-operations/${installOperation?.id}/signature`,
    );
    const { signature } = JSON.parse(submit?.body ?? "{}");
    const op = api.ownerOperations.get(installOperation?.id ?? "");
    const recovered = await recoverMessageAddress({
      message: { raw: op?.user_op_hash as `0x${string}` },
      signature,
    });
    expect(recovered).toBe(owner.address);
  });

  it("uses distinct idempotency keys per step when the caller passes one", async () => {
    const before = api.requests.length;
    await principal().grantSession(
      {
        accountId: ACCT,
        publicKey: generateSessionKey().address,
        scope: { max_per_tx: "1", max_per_day: "2" },
      },
      { idempotencyKey: "grant-0001" },
    );
    const keys = api.requests
      .slice(before)
      .map((r) => r.headers["idempotency-key"])
      .filter(Boolean);
    expect(keys).toEqual(["grant-0001.create", "grant-0001.install", "grant-0001.sign"]);
  });

  it("is rejected by the API when signed by another key", async () => {
    const impostor = new PrincipalClient({
      baseUrl: api.url,
      apiKey: "abk_test_fake",
      owner: privateKeyToAccount(generatePrivateKey()),
    });
    const error = await impostor
      .grantSession({
        accountId: ACCT,
        publicKey: generateSessionKey().address,
        scope: { max_per_tx: "1", max_per_day: "1" },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect((error as PermissionDeniedError).code).toBe("owner_signature_required");
  });

  it("validates the scope and requires an owner key", async () => {
    await expect(
      principal().grantSession({
        accountId: ACCT,
        publicKey: generateSessionKey().address,
        scope: { max_per_tx: "1", max_per_day: "1" },
        ttlSeconds: 8 * 86400,
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      principal().grantSession({
        accountId: ACCT,
        publicKey: generateSessionKey().address,
        scope: { max_per_tx: "-1", max_per_day: "1" },
      }),
    ).rejects.toThrow(/max_per_tx/);
    await expect(
      principal(false).grantSession({
        accountId: ACCT,
        publicKey: generateSessionKey().address,
        scope: { max_per_tx: "1", max_per_day: "1" },
      }),
    ).rejects.toThrow(/owner key/);
  });
});

describe("owner authorization chain id from GET /v1/meta", () => {
  it("fetches owner_authorization_chain_id once and caches it", async () => {
    const client = principal();
    const before = api.requests.length;
    await client.setPolicy(AGENT, { limits: { per_tx: "40.00" } });
    await client.unfreezeAgent(AGENT, "investigated");
    await client.grantSession({
      accountId: ACCT,
      publicKey: generateSessionKey().address,
      scope: { max_per_tx: "1", max_per_day: "2" },
    });
    const metaCalls = api.requests.slice(before).filter((r) => r.url === "/v1/meta");
    expect(metaCalls).toHaveLength(1);
    expect(metaCalls[0]?.auth).toBe("none");
    expect(await client.ownerAuthorizationChainId()).toBe(84532);
  });

  it("signs for sandbox deployments on the simulated chain (1337)", async () => {
    const sandbox = await startFakeApi({ ownerAddress: owner.address, ownerAuthorizationChainId: 1337 });
    try {
      const client = new PrincipalClient({ baseUrl: sandbox.url, apiKey: "abk_test_fake", owner });
      expect((await client.meta()).owner_authorization_chain_id).toBe(1337);
      const { session } = await client.grantSession({
        accountId: ACCT,
        publicKey: generateSessionKey().address,
        scope: { max_per_tx: "5.00", max_per_day: "50.00" },
      });
      expect(session.status).toBe("pending_install");

      // A hard-coded chain id (84532) is rejected by a 1337 deployment, and skips /v1/meta.
      const pinned = new PrincipalClient({
        baseUrl: sandbox.url,
        apiKey: "abk_test_fake",
        owner,
        chainId: 84532,
      });
      const before = sandbox.requests.length;
      const error = await pinned.unfreezeAgent(AGENT, "test").catch((e: unknown) => e);
      expect((error as AgentBankError).code).toBe("signature_invalid");
      expect(sandbox.requests.slice(before).some((r) => r.url === "/v1/meta")).toBe(false);
    } finally {
      await sandbox.close();
    }
  });

  it("refuses a mainnet chain id served by /v1/meta", async () => {
    const rogue = await startFakeApi({ ownerAddress: owner.address, ownerAuthorizationChainId: 8453 });
    try {
      const client = new PrincipalClient({ baseUrl: rogue.url, apiKey: "abk_test_fake", owner });
      const error = await client.setPolicy(AGENT, { limits: { per_tx: "1.00" } }).catch((e: unknown) => e);
      expect((error as AgentBankError).code).toBe("mainnet_locked");
      expect(rogue.requests.some((r) => r.url.startsWith("/v1/agents/"))).toBe(false);
    } finally {
      await rogue.close();
    }
  });
});

describe("canonical owner payloads (core ownerPayloads)", () => {
  it("signs agent.unfreeze and topup.set exactly as the verifier rebuilds them", async () => {
    const client = principal();
    const agent = await client.unfreezeAgent(AGENT, "false alarm");
    expect(agent.pending_unfreeze_at).not.toBeNull();
    const before = api.requests.length;
    const rule = await client.setAutoTopUp(
      AGENT,
      {
        refill_to: { amount: "100.00", asset: "USDC" },
        when_below: { amount: "20.00", asset: "USDC" },
        max_per_day: { amount: "300.00", asset: "USDC" },
        // Unknown fields are dropped from both the signed payload and the body.
        ...({ note: "ignored" } as object),
      } as Parameters<PrincipalClient["setAutoTopUp"]>[1],
      { waitForInstall: { intervalMs: 5 } },
    );
    expect(rule.status).toBe("active");
    const put = api.requests.slice(before).find((r) => r.method === "PUT");
    const sent = JSON.parse(put?.body ?? "{}");
    expect(Object.keys(sent).sort()).toEqual([
      "max_per_day",
      "owner_authorization",
      "refill_to",
      "when_below",
    ]);
    // The executor install owner operation was signed by the owner key.
    const op = api.ownerOperations.get(rule.install_operation_id ?? "");
    expect(op?.purpose).toBe("topup.configure");
    expect(op?.status).toBe("succeeded");
  });
});

describe("owner-key rotation and on-chain session revocation", () => {
  it("prepares and signs the Safe owner swap, then rotates with owner.rotate", async () => {
    const client = principal();
    const next = privateKeyToAccount(generatePrivateKey()).address;
    const swap = await client.prepareOwnerSwap(ACCT, next, { wait: { intervalMs: 5 } });
    expect(swap.purpose).toBe("owner.swap");
    expect(swap.status).toBe("succeeded");
    const org = await client.rotateOwner(next);
    expect(org.owner_address).toBe(next);
    const sent = JSON.parse(api.requests.at(-1)?.body ?? "{}");
    expect(sent.owner_authorization.signer).toBe(owner.address);
  });

  it("revokes a session off-chain and signs the on-chain revoke operation", async () => {
    const client = principal();
    const { session } = await client.grantSession({
      accountId: ACCT,
      publicKey: generateSessionKey().address,
      scope: { max_per_tx: "1", max_per_day: "1" },
      install: false,
    });
    const revoked = await client.revokeSession(session.id, { waitForInstall: { intervalMs: 5 } });
    expect(revoked.status).toBe("revoked");
    const op = api.ownerOperations.get(revoked.revoke_operation_id ?? "");
    expect(op?.purpose).toBe("session.revoke");
    expect(op?.status).toBe("succeeded");
    const offChainOnly = await client.grantSession({
      accountId: ACCT,
      publicKey: generateSessionKey().address,
      scope: { max_per_tx: "1", max_per_day: "1" },
      install: false,
    });
    const quick = await client.revokeSession(offChainOnly.session.id, { onchain: false });
    expect(api.ownerOperations.get(quick.revoke_operation_id ?? "")?.status).toBe("requires_signature");
  });
});

describe("PrincipalClient.setPolicy", () => {
  it("normalizes the policy and attaches a verified policy.loosen authorization", async () => {
    const result = await principal().setPolicy(AGENT, {
      limits: { per_tx: "50.00", per_day: "500.00" },
      counterparties: { mode: "allowlist", x402_domains: ["api.example-data.com"] },
    });
    expect(result.current?.change_kind).toBe("loosen");
    const put = api.requests.at(-1);
    const body = JSON.parse(put?.body ?? "{}");
    expect(body.policy.asset).toBe("USDC");
    expect(body.owner_authorization.signer).toBe(owner.address);
  });

  it("sends tightening changes unsigned when asked", async () => {
    const result = await principal().setPolicy(AGENT, { limits: { per_tx: "5.00" } }, { authorize: false });
    expect(result.current?.change_kind).toBe("tighten");
    await expect(principal().setPolicy(AGENT, { limits: { per_tx: 5 } } as never)).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });
});
