import { newId, ownerPayloads, type OpenPaymentMandate, type SessionScope } from "@agentbank/core";
import { getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keys, signOwnerAction, World } from "./helpers";

let w: World;

beforeAll(async () => {
  w = await World.create();
});

afterAll(async () => {
  await w.close();
});

function scope(overrides: Partial<SessionScope> = {}): SessionScope {
  return {
    asset: "USDC",
    max_per_tx: "10.00",
    max_per_day: "20.00",
    expires_at: new Date(w.clock.now().getTime() + 3600_000).toISOString(),
    ...overrides,
  };
}

async function sessionRequest(
  sessionId: string,
  s: SessionScope,
  opts: { signer?: typeof keys.owner; signedScope?: SessionScope; accountAddress?: `0x${string}` } = {},
) {
  return {
    session_id: sessionId,
    org_id: w.org,
    agent_id: w.agent,
    account_id: w.accountId,
    chain_id: w.chain.chainId,
    account_address: opts.accountAddress ?? w.account,
    owner_address: keys.owner.address,
    public_key: keys.otherSession.address,
    scope: s,
    owner_authorization: await signOwnerAction(
      opts.signer ?? keys.owner,
      w.chain.chainId,
      ownerPayloads.sessionGrant({
        account_id: w.accountId,
        public_key: keys.otherSession.address,
        scope: opts.signedScope ?? s,
      }),
      w.now(),
    ),
  };
}

describe("session registration", () => {
  it("registers a session granted by the owner, idempotently, and refuses conflicting re-registration", async () => {
    const id = newId("session");
    const request = await sessionRequest(id, scope());
    await w.client.registerSession(request);
    await w.client.registerSession(request);
    await expect(
      w.client.registerSession(await sessionRequest(id, scope({ max_per_day: "30.00" }))),
    ).rejects.toMatchObject({ code: "conflict" });
    const records = (await w.client.audit(0, 1000)).records.filter(
      (r) => r.action === "session.registered" && r.subject === id,
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.actor).toBe(`owner:${keys.owner.address}`);
  });

  it("requires the owner's session.grant over exactly this scope", async () => {
    await expect(
      w.client.registerSession(await sessionRequest(newId("session"), scope(), { signer: keys.attacker })),
    ).rejects.toMatchObject({ code: "owner_signature_required" });
    // A compromised API widening the scope the owner signed.
    const signed = scope();
    const widened = scope({ max_per_day: "20000.00" });
    await expect(
      w.client.registerSession(await sessionRequest(newId("session"), widened, { signedScope: signed })),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("refuses scopes that are expired or longer than seven days", async () => {
    await expect(
      w.client.registerSession(
        await sessionRequest(
          newId("session"),
          scope({ expires_at: new Date(w.clock.now().getTime() - 1000).toISOString() }),
        ),
      ),
    ).rejects.toMatchObject({ code: "session_expired" });
    await expect(
      w.client.registerSession(
        await sessionRequest(
          newId("session"),
          scope({ expires_at: new Date(w.clock.now().getTime() + 8 * 86_400_000).toISOString() }),
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("pins accounts to their address: a known account id cannot be moved", async () => {
    const elsewhere = getAddress("0x00000000000000000000000000000000000a11ce");
    await expect(
      w.client.registerSession(
        await sessionRequest(newId("session"), scope(), { accountAddress: elsewhere }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("revoking an unknown session tombstones it", async () => {
    const id = newId("session");
    await w.client.revokeSession(id);
    await expect(w.client.registerSession(await sessionRequest(id, scope()))).rejects.toMatchObject({
      code: "session_revoked",
    });
  });

  it("refuses a session whose key is the co-signer's own key (the 2-of-2 would collapse)", async () => {
    const request = await sessionRequest(newId("session"), scope());
    await expect(
      w.client.registerSession({ ...request, public_key: w.signer.address }),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("refuses another chain", async () => {
    await expect(
      w.client.registerSession({ ...(await sessionRequest(newId("session"), scope())), chain_id: 84532 }),
    ).rejects.toMatchObject({ code: "unsupported_chain" });
  });
});

describe("mandate registration", () => {
  function mandate(overrides: Partial<OpenPaymentMandate> = {}): OpenPaymentMandate {
    return {
      vct: "mandate.payment.open.1",
      constraints: [{ type: "payment.budget", currency: "USD", max: 5000 }],
      iat: w.now(),
      exp: w.now() + 3600,
      agent_id: w.agent,
      ...overrides,
    };
  }

  async function mandateRequest(id: string, m: OpenPaymentMandate, signer = keys.owner) {
    return {
      mandate_id: id,
      org_id: w.org,
      agent_id: w.agent,
      chain_id: w.chain.chainId,
      owner_address: keys.owner.address,
      mandate: m,
      owner_authorization: await signOwnerAction(
        signer,
        w.chain.chainId,
        ownerPayloads.mandateIssue(w.agent, m),
        w.now(),
      ),
    };
  }

  it("registers an owner-signed mandate idempotently and refuses other content under the same id", async () => {
    const request = await mandateRequest("mdt_registry_1", mandate());
    await w.client.registerMandate(request);
    await w.client.registerMandate(request);
    w.clock.advanceSeconds(1);
    await expect(
      w.client.registerMandate(await mandateRequest("mdt_registry_1", mandate({ description: "other" }))),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses mandates not signed by the owner, for another agent, or already expired", async () => {
    await expect(
      w.client.registerMandate(await mandateRequest("mdt_registry_2", mandate(), keys.attacker)),
    ).rejects.toMatchObject({ code: "owner_signature_required" });
    await expect(
      w.client.registerMandate(await mandateRequest("mdt_registry_3", mandate({ agent_id: newId("agent") }))),
    ).rejects.toMatchObject({ code: "mandate_invalid" });
    await expect(
      w.client.registerMandate(
        await mandateRequest("mdt_registry_4", mandate({ iat: w.now() - 7200, exp: w.now() - 60 })),
      ),
    ).rejects.toMatchObject({ code: "mandate_expired" });
  });

  it("a revoked mandate id can never be registered", async () => {
    await w.client.revokeMandate("mdt_registry_5");
    await expect(
      w.client.registerMandate(await mandateRequest("mdt_registry_5", mandate())),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});
