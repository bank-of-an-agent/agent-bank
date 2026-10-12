import { readFileSync } from "node:fs";
import { verifyOwnerAuthorization } from "@agentbank/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentClient,
  InvalidRequestError,
  ownerPayloads,
  PermissionDeniedError,
  PrincipalClient,
} from "../src";
import { startFakeApi, type FakeApi } from "./helpers/fake-api";

const vectors = JSON.parse(
  readFileSync(new URL("../../core/test/vectors/vectors.json", import.meta.url), "utf8"),
) as { keys: { owner_private_key: `0x${string}` } };

const owner = privateKeyToAccount(vectors.keys.owner_private_key);
const ACCT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
const AGENT = "agt_01JABCDEFGHJKMNPQRSTVWXYZ0";
const SES = "ses_01JABCDEFGHJKMNPQRSTVWXYZ0";
const sessionKey = privateKeyToAccount(generatePrivateKey());

let api: FakeApi;

beforeAll(async () => {
  api = await startFakeApi({
    ownerAddress: owner.address,
    sessions: [{ id: SES, address: sessionKey.address, accountId: ACCT }],
    accounts: [{ id: ACCT, agent_id: AGENT }],
  });
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

const lastBody = () => JSON.parse(api.requests.at(-1)?.body ?? "{}") as Record<string, unknown>;

describe("principal.proofs.configure", () => {
  it("signs proofs.disclose when the change widens disclosure", async () => {
    const client = principal();
    expect(await client.proofs.settings(AGENT)).toMatchObject({
      enabled: false,
      disclose: [],
      updated_at: null,
    });
    const settings = await client.proofs.configure(AGENT, {
      enabled: true,
      disclose: ["reputation", "principal", "limits", "principal"],
    });
    expect(settings).toMatchObject({ enabled: true, disclose: ["principal", "limits", "reputation"] });
    const put = api.requests.at(-1);
    expect(put).toMatchObject({
      method: "PUT",
      url: `/v1/agents/${AGENT}/proofs/settings`,
      auth: "principal",
    });
    const body = lastBody() as {
      enabled: boolean;
      disclose: string[];
      owner_authorization: Record<string, unknown>;
    };
    expect(body.disclose).toEqual(["principal", "limits", "reputation"]);
    const oa = body.owner_authorization;
    await verifyOwnerAuthorization({
      chainId: 84532,
      ...ownerPayloads.proofsDisclose(AGENT, {
        enabled: true,
        disclose: ["principal", "limits", "reputation"],
      }),
      issuedAt: oa.issued_at as number,
      expiresAt: oa.expires_at as number,
      owner: owner.address,
      signer: oa.signer as `0x${string}`,
      signature: oa.signature as `0x${string}`,
    });

    // Adding one class is widening too.
    await client.proofs.configure(AGENT, {
      enabled: true,
      disclose: ["limits", "principal", "reputation", "balance"],
    });
    expect(lastBody().owner_authorization).toBeDefined();
  });

  it("sends a narrowing (or unchanged) setting without a signature, and needs no owner key for it", async () => {
    const client = principal(false);
    const narrowed = await client.proofs.configure(AGENT, { enabled: true, disclose: ["principal"] });
    expect(narrowed.disclose).toEqual(["principal"]);
    expect(lastBody()).toEqual({ enabled: true, disclose: ["principal"] });
    await client.proofs.configure(AGENT, { enabled: true, disclose: ["principal"] });
    expect(lastBody().owner_authorization).toBeUndefined();
    const disabled = await client.proofs.configure(AGENT, { enabled: false, disclose: ["principal"] });
    expect(disabled.enabled).toBe(false);
    expect(lastBody().owner_authorization).toBeUndefined();
  });

  it("refuses to widen without the owner key, and rejects unknown classes before sending", async () => {
    const count = api.requests.length;
    const noOwner = await principal(false)
      .proofs.configure(AGENT, { enabled: true, disclose: ["principal", "balance"] })
      .catch((e: unknown) => e);
    expect(noOwner).toBeInstanceOf(InvalidRequestError);
    expect((noOwner as Error).message).toMatch(/owner key/);
    // Only the settings read went out.
    expect(api.requests.slice(count).map((r) => r.method)).toEqual(["GET"]);

    await expect(
      principal().proofs.configure(AGENT, { enabled: true, disclose: ["everything" as never] }),
    ).rejects.toThrow(/unknown: everything/);
    await expect(
      principal().proofs.configure(AGENT, { enabled: "yes" as never, disclose: [] }),
    ).rejects.toThrow(InvalidRequestError);

    // The raw operation without a signature is what the owner signature protects against.
    const unsigned = await principal()
      .proofs.updateSettings(AGENT, { enabled: true, disclose: ["principal", "balance", "reputation"] })
      .catch((e: unknown) => e);
    expect(unsigned).toBeInstanceOf(PermissionDeniedError);
    expect((unsigned as PermissionDeniedError).code).toBe("owner_signature_required");
  });
});

describe("principal.proofs reservations", () => {
  it("lists an account's reservations and releases one with an owner signature", async () => {
    const agent = new AgentClient({
      baseUrl: api.url,
      accountId: ACCT,
      session: { id: SES, signer: sessionKey },
    });
    const reservation = await agent.proofs.reserve({
      amount: "250.00",
      scope: "api.seller.example",
      forSeconds: 3_600,
    });
    const client = principal();
    const page = await client.proofs.reservations(ACCT, { status: "active" });
    expect(page.data.map((r) => r.id)).toContain(reservation.id);
    expect(await client.proofs.retrieveReservation(reservation.id)).toMatchObject({ status: "active" });

    const released = await client.proofs.releaseReservation(reservation.id);
    expect(released).toMatchObject({ id: reservation.id, status: "released" });
    expect(released.released_at).not.toBeNull();
    const post = api.requests.at(-1);
    expect(post).toMatchObject({ method: "POST", url: `/v1/proofs/reservations/${reservation.id}/release` });
    const oa = (lastBody() as { owner_authorization: Record<string, unknown> }).owner_authorization;
    await verifyOwnerAuthorization({
      chainId: 84532,
      ...ownerPayloads.proofReservationRelease(reservation.id),
      issuedAt: oa.issued_at as number,
      expiresAt: oa.expires_at as number,
      owner: owner.address,
      signer: oa.signer as `0x${string}`,
      signature: oa.signature as `0x${string}`,
    });
  });

  it("sends an authorization signed elsewhere as is, and needs the owner key otherwise", async () => {
    const agent = new AgentClient({
      baseUrl: api.url,
      accountId: ACCT,
      session: { id: SES, signer: sessionKey },
    });
    const reservation = await agent.proofs.reserve({ amount: "1.00", scopeTag: "42", forSeconds: 600 });
    await expect(principal(false).proofs.releaseReservation(reservation.id)).rejects.toThrow(/owner key/);
    const owner_authorization = await principal().authorize(
      ownerPayloads.proofReservationRelease(reservation.id),
    );
    const released = await principal(false).proofs.releaseReservation(reservation.id, {
      owner_authorization,
    });
    expect(released.status).toBe("released");
  });
});
