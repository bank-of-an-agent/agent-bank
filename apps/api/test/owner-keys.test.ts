import { type PreparedOperation } from "@agentbank/chain";
import { ownerPayloads, usdc } from "@agentbank/core";
import { maxUint256, toFunctionSelector } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentCall,
  call,
  createAgent,
  createHarness,
  ownerAuth,
  signupOrg,
  type Harness,
  type Json,
  type TestOrg,
} from "./support/harness";
import {
  attachSpendKey,
  createSession,
  DEFAULT_POLICY,
  onboard,
  payAndSign,
  putPolicy,
  signHash,
  signOwnerOperation,
  signSpendKeyPermit,
  type World,
} from "./support/flows";

let h: Harness;
let w: World;
const money = (amount: string) => ({ amount, asset: "USDC" });

const PERMIT_SELECTOR = toFunctionSelector("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)");

beforeAll(async () => {
  h = await createHarness();
  w = await onboard(h, { name: "keys", fund: usdc("100") });
});
afterAll(async () => h.close());

async function storedCalls(opId: string) {
  const { rows } = await h.db.query<{ user_op: PreparedOperation }>(
    "SELECT user_op FROM owner_operation WHERE id = $1",
    [opId],
  );
  return h.chain.decodeOperation(rows[0]?.user_op as PreparedOperation);
}

describe("x402 spend key and its float-recovery permit (ADR 0001)", () => {
  let org: TestOrg;
  let agent: Json;
  let account: Json;
  const spendKey = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    org = await signupOrg(h.app, "Permit Co");
    agent = await createAgent(h.app, org.apiKey, "permit-agent");
    const created = await call(h.app, "POST", `/v1/agents/${agent.id}/accounts`, {
      token: org.apiKey,
      body: { chain: "simulated", spend_key_address: spendKey.address },
    });
    expect(created.status).toBe(201);
    account = created.body;
    expect(account.spend_key_permit).toBe("none");
  });

  it("needs the owner's spend_key.set authorization, a valid permit and the same key", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const permit = await signSpendKeyPermit(h, spendKey, account.address);
    const unauthorized = await call(h.app, "PUT", `/v1/accounts/${account.id}/spend-key`, {
      token: org.apiKey,
      body: {
        spend_key_address: spendKey.address,
        permit,
        owner_authorization: await ownerAuth(
          stranger,
          h.clock,
          "spend_key.set",
          account.id,
          ownerPayloads.spendKeySet(account.id, spendKey.address).payload,
        ),
      },
    });
    expect(unauthorized.status).toBe(403);
    expect(unauthorized.body.code).toBe("owner_signature_required");
    const forged = await attachSpendKey(
      h,
      org,
      account,
      spendKey,
      await signSpendKeyPermit(h, stranger, account.address),
    );
    expect(forged.status).toBe(400);
    const wrongSpender = await attachSpendKey(
      h,
      org,
      account,
      spendKey,
      await signSpendKeyPermit(h, spendKey, stranger.address),
    );
    expect(wrongSpender.status).toBe(400);
    const staleNonce = await attachSpendKey(
      h,
      org,
      account,
      spendKey,
      await signSpendKeyPermit(h, spendKey, account.address, { nonce: 5n }),
    );
    expect(staleNonce.status).toBe(400);
    expect(staleNonce.body.detail).toMatch(/nonces/);
    const other = await attachSpendKey(h, org, account, stranger);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe("conflict");
    expect(
      h.cosigner
        .callsTo("registerSpendKey")
        .filter((c) => (c as { account_id: string }).account_id === account.id),
    ).toEqual([]);
  });

  it("registers the key with the co-signer and executes the permit in the setup operation", async () => {
    const permit = await signSpendKeyPermit(h, spendKey, account.address);
    const attached = await attachSpendKey(h, org, account, spendKey, permit);
    expect(attached.status).toBe(200);
    expect(attached.body).toMatchObject({ spend_key_address: spendKey.address, spend_key_permit: "pending" });
    expect(h.cosigner.callsTo("registerSpendKey")).toContainEqual(
      expect.objectContaining({ account_id: account.id, spend_key_address: spendKey.address }),
    );

    expect((await putPolicy(h, org, agent.id, DEFAULT_POLICY)).status).toBe(200);
    const { session } = await createSession(h, org, account.id);
    const install = await call(h.app, "POST", `/v1/sessions/${session.id}/install`, { token: org.apiKey });
    const opId = install.body.install_operation_id as string;
    const calls = await storedCalls(opId);
    // Anyone may submit a permit: it rides in the setup batch, which runs before the hook exists.
    const permitCall = calls.at(-1);
    expect(permitCall).toMatchObject({ to: h.chain.contracts.usdc });
    expect(permitCall?.data.startsWith(PERMIT_SELECTOR)).toBe(true);

    const signed = await signOwnerOperation(h, org, opId);
    expect(signed.body.status).toBe("succeeded");
    const after = await call(h.app, "GET", `/v1/accounts/${account.id}`, { token: org.apiKey });
    expect(after.body).toMatchObject({ deployed: true, spend_key_permit: "executed" });
    expect(h.sim.usdc.allowance(spendKey.address, account.address)).toBe(maxUint256);

    // Idempotent for the same permit; nothing else once it is on-chain.
    expect((await attachSpendKey(h, org, account, spendKey, permit)).status).toBe(200);
    const replaced = await attachSpendKey(h, org, account, spendKey);
    expect(replaced.status).toBe(409);
  });

  it("refuses refills and x402 until the spend key is registered", async () => {
    const x = await onboard(h, { name: "unregistered", fund: usdc("50"), attachSpendKey: false });
    const refill = await payAndSign(h, x, { amount: money("5.00"), to: { address: x.spendKey.address } });
    expect(refill.body).toMatchObject({ kind: "refill", status: "denied" });
    const paid = await agentCall(h, x.session, "POST", "/v1/x402/pay", {
      body: {
        account_id: x.account.id,
        resource: { url: "https://api.example-data.com/report" },
        requirements: {
          scheme: "exact",
          network: "eip155:1337",
          asset: h.chain.contracts.usdc,
          amount: "1000",
          payTo: w.account.address,
          maxTimeoutSeconds: 60,
          extra: { name: "USDC", version: "2" },
        },
      },
    });
    expect(paid.status).toBe(422);
    expect(paid.body.code).toBe("policy_denied");

    // Attached after setup: registered at once; the permit goes straight to USDC via the relayer
    // (the hook refuses `permit` on the account's own path once installed).
    const attached = await attachSpendKey(h, x, x.account, x.spendKey);
    expect(attached.status).toBe(200);
    expect(attached.body.spend_key_permit).toBe("executed");
    expect(h.sim.usdc.allowance(x.spendKey.address, x.account.address)).toBe(maxUint256);
    const ok = await payAndSign(h, x, { amount: money("5.00"), to: { address: x.spendKey.address } });
    expect(ok.body).toMatchObject({ kind: "refill", status: "submitted", fee: money("0.00") });
  });

  it("requires the spend key among a session's restricted recipients", async () => {
    const res = await call(h.app, "POST", "/v1/sessions", {
      token: w.apiKey,
      body: {
        account_id: w.account.id,
        public_key: privateKeyToAccount(generatePrivateKey()).address,
        scope: {
          max_per_tx: "10.00",
          max_per_day: "20.00",
          expires_at: new Date(h.clock.now().getTime() + 3_600_000).toISOString(),
          allowed_recipients: ["0x1111111111111111111111111111111111111111"],
        },
        owner_authorization: await ownerAuth(w.owner, h.clock, "session.grant", w.account.id, {}),
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/spend key/);
  });
});

describe("owner key rotation", () => {
  it("rotates the Safe and OwnableValidator owners in one owner operation", async () => {
    const x = await onboard(h, { name: "swapper", fund: usdc("20") });
    const next = privateKeyToAccount(generatePrivateKey());
    const same = await call(h.app, "POST", `/v1/accounts/${x.account.id}/owner-swap`, {
      token: x.apiKey,
      body: { new_owner_address: x.owner.address },
    });
    expect(same.status).toBe(400);
    const res = await call(h.app, "POST", `/v1/accounts/${x.account.id}/owner-swap`, {
      token: x.apiKey,
      body: { new_owner_address: next.address },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      object: "owner_operation",
      purpose: "owner.swap",
      subject_id: next.address,
      account_id: x.account.id,
      status: "requires_signature",
    });
    const calls = await storedCalls(res.body.id);
    expect(calls.map((c) => [c.to, c.data.slice(0, 10)])).toEqual([
      [x.account.address, toFunctionSelector("swapOwner(address,address,address)")],
      [h.chain.contracts.ownableValidator, toFunctionSelector("addOwner(address)")],
      [h.chain.contracts.ownableValidator, toFunctionSelector("removeOwner(address,address)")],
    ]);
    const twice = await call(h.app, "POST", `/v1/accounts/${x.account.id}/owner-swap`, {
      token: x.apiKey,
      body: { new_owner_address: next.address },
    });
    expect(twice.status).toBe(409);
    // Signed by the CURRENT owner only.
    const byNewKey = await call(h.app, "POST", `/v1/owner-operations/${res.body.id}/signature`, {
      token: x.apiKey,
      body: { signature: await signHash(next, res.body.user_op_hash) },
    });
    expect(byNewKey.status).toBe(403);
    expect(byNewKey.body.code).toBe("owner_signature_required");
    const signed = await signOwnerOperation(h, x, res.body.id);
    expect(signed.body.status).toBe("succeeded");
    const account = await call(h.app, "GET", `/v1/accounts/${x.account.id}`, { token: x.apiKey });
    expect(account.body.owner_address).toBe(next.address);
    expect(h.sim.account(x.account.address)?.ownerValidator.owners).toEqual([next.address]);

    // The new key signs this account's owner operations from now on (the old one cannot).
    const revoked = await call(h.app, "DELETE", `/v1/sessions/${x.session.id}`, { token: x.apiKey });
    const opId = revoked.body.revoke_operation_id as string;
    const op = await call(h.app, "GET", `/v1/owner-operations/${opId}`, { token: x.apiKey });
    const byOldKey = await call(h.app, "POST", `/v1/owner-operations/${opId}/signature`, {
      token: x.apiKey,
      body: { signature: await signHash(x.owner, op.body.user_op_hash) },
    });
    expect(byOldKey.status).toBe(403);
    const byNew = await call(h.app, "POST", `/v1/owner-operations/${opId}/signature`, {
      token: x.apiKey,
      body: { signature: await signHash(next, op.body.user_op_hash) },
    });
    expect(byNew.body.status).toBe("succeeded");
  });

  it("rotates the org owner with the current owner's authorization", async () => {
    const x = await onboard(h, { name: "rotator" });
    const next = privateKeyToAccount(generatePrivateKey());
    const payload = ownerPayloads.ownerRotate(x.org.id, next.address).payload;
    const byNewKey = await call(h.app, "POST", "/v1/orgs/me/owner", {
      token: x.apiKey,
      body: {
        new_owner_address: next.address,
        owner_authorization: await ownerAuth(next, h.clock, "owner.rotate", x.org.id, payload),
      },
    });
    expect(byNewKey.status).toBe(403);
    const res = await call(h.app, "POST", "/v1/orgs/me/owner", {
      token: x.apiKey,
      body: {
        new_owner_address: next.address,
        owner_authorization: await ownerAuth(x.owner, h.clock, "owner.rotate", x.org.id, payload),
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.owner_address).toBe(next.address);
    expect(h.cosigner.callsTo("rotateOwner")).toContainEqual(
      expect.objectContaining({ org_id: x.org.id, new_owner_address: next.address }),
    );
    // Loosening now needs the new key, at the API and at the co-signer.
    h.clock.advanceSeconds(1);
    const loosened = {
      limits: { per_tx: "2000.00", per_day: "5000.00" },
      counterparties: { mode: "open" as const },
    };
    expect((await putPolicy(h, x, x.agent.id, loosened)).status).toBe(403);
    expect((await putPolicy(h, { apiKey: x.apiKey, owner: next }, x.agent.id, loosened)).status).toBe(200);
  });

  it("rotates an org the co-signer has not seen yet", async () => {
    const fresh = await signupOrg(h.app, "Fresh");
    const next = privateKeyToAccount(generatePrivateKey());
    const payload = ownerPayloads.ownerRotate(fresh.org.id, next.address).payload;
    const res = await call(h.app, "POST", "/v1/orgs/me/owner", {
      token: fresh.apiKey,
      body: {
        new_owner_address: next.address,
        owner_authorization: await ownerAuth(fresh.owner, h.clock, "owner.rotate", fresh.org.id, payload),
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.owner_address).toBe(next.address);
  });

  it("registers the org treasury with the co-signer", async () => {
    const treasury = await call(h.app, "POST", "/v1/orgs/me/treasury-accounts", {
      token: w.apiKey,
      body: { chain: "simulated" },
    });
    expect(treasury.status).toBe(201);
    const payload = ownerPayloads.treasurySet(w.org.id, treasury.body.id).payload;
    const res = await call(h.app, "PUT", "/v1/orgs/me/treasury", {
      token: w.apiKey,
      body: {
        account_id: treasury.body.id,
        owner_authorization: await ownerAuth(w.owner, h.clock, "treasury.set", w.org.id, payload),
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.treasury_account_id).toBe(treasury.body.id);
    expect(h.cosigner.callsTo("setTreasury")).toContainEqual(
      expect.objectContaining({
        org_id: w.org.id,
        account_id: treasury.body.id,
        treasury_address: treasury.body.address,
      }),
    );
    const agentAccount = await call(h.app, "PUT", "/v1/orgs/me/treasury", {
      token: w.apiKey,
      body: {
        account_id: w.account.id,
        owner_authorization: await ownerAuth(
          w.owner,
          h.clock,
          "treasury.set",
          w.org.id,
          ownerPayloads.treasurySet(w.org.id, w.account.id).payload,
        ),
      },
    });
    expect(agentAccount.status).toBe(400);
  });
});
