import { newId, ownerPayloads } from "@agentbank/core";
import { getAddress, type Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { ATTACKER, keys, PAYEE, REVENUE, signOwnerAction, usd, World } from "./helpers";

let w: World;

afterEach(async () => {
  await w.close();
});

function x402(spendKey: Address = keys.spendKey.address) {
  return {
    payment_id: newId("payment"),
    org_id: w.org,
    agent_id: w.agent,
    account_id: w.accountId,
    account_address: w.account,
    chain_id: w.chain.chainId,
    spend_key_address: spendKey,
    x402_domain: "api.example-data.com",
    pay_to: PAYEE,
    amount: usd(1).toString(),
    asset: "USDC" as const,
  };
}

async function registrations(): Promise<number> {
  return (await w.client.audit(0, 1000)).records.filter((r) => r.action === "spend_key.registered").length;
}

describe("spend key registration (owner consent, ADR 0001)", () => {
  it("registers the key only with the pinned owner's spend_key.set authorization", async () => {
    w = await World.create();
    // Wrong owner: signed by another key, or naming another "owner".
    await expect(
      w.client.registerSpendKey(await w.spendKeyRequest(keys.spendKey.address, keys.attacker)),
    ).rejects.toMatchObject({
      code: "owner_signature_required",
    });
    const claimed = await w.spendKeyRequest(keys.spendKey.address, keys.attacker);
    await expect(
      w.client.registerSpendKey({ ...claimed, owner_address: keys.attacker.address }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    // Signed for another key than the one registered.
    const signed = await w.spendKeyRequest(keys.spendKey.address);
    await expect(w.client.registerSpendKey({ ...signed, spend_key_address: ATTACKER })).rejects.toMatchObject(
      {
        code: "signature_invalid",
      },
    );
    expect((await w.client.authorizeX402(x402())).decision.outcome).toBe("deny");

    await w.client.registerSpendKey(signed);
    expect((await w.client.authorizeX402(x402())).decision.outcome).toBe("allow");
    const records = (await w.client.audit(0, 1000)).records.filter(
      (r) => r.action === "spend_key.registered",
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.actor).toBe(`owner:${keys.owner.address}`);
  });

  it("is single-use: a retry changes nothing, and a replayed authorization cannot pin the key again", async () => {
    w = await World.create();
    const request = await w.spendKeyRequest();
    await w.client.registerSpendKey(request);
    await w.client.registerSpendKey(request); // identical retry: no-op
    expect(await registrations()).toBe(1);
    // Even if an operator removed the pin, the consumed authorization cannot restore it.
    await w.db.query("DELETE FROM spend_key_binding WHERE account_id = $1", [w.accountId]);
    await expect(w.client.registerSpendKey(request)).rejects.toMatchObject({ code: "conflict" });
    expect(await registrations()).toBe(1);
  });

  it("refuses a second key for the account and one key for two accounts", async () => {
    w = await World.create();
    await w.registerSpendKey();
    w.clock.advanceSeconds(1);
    await expect(
      w.client.registerSpendKey(await w.spendKeyRequest(keys.otherSession.address)),
    ).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
    // The x402 path names the registered key only.
    const other = await w.client.authorizeX402(x402(keys.otherSession.address));
    expect(other.decision.rule_hits).toContainEqual(
      expect.objectContaining({ rule: "cosigner.spend_key", effect: "deny" }),
    );
    // Another account of the same org cannot reuse the key.
    const accountId = newId("account");
    const otherAccount = getAddress("0x00000000000000000000000000000000000acc02");
    await expect(
      w.client.registerSpendKey({
        ...(await w.spendKeyRequest()),
        account_id: accountId,
        account_address: otherAccount,
        owner_authorization: await signOwnerAction(
          keys.owner,
          w.chain.chainId,
          ownerPayloads.spendKeySet(accountId, keys.spendKey.address),
          w.now(),
        ),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses keys that are the account, the owner, the co-signer, the revenue address or the treasury", async () => {
    w = await World.create();
    const treasury = getAddress("0x0000000000000000000000000000000000007ea5");
    await w.client.setTreasury({
      org_id: w.org,
      chain_id: w.chain.chainId,
      owner_address: keys.owner.address,
      account_id: "acct_01JTREASURY0000000000000000",
      treasury_address: treasury,
      owner_authorization: await signOwnerAction(
        keys.owner,
        w.chain.chainId,
        ownerPayloads.treasurySet(w.org, "acct_01JTREASURY0000000000000000"),
        w.now(),
      ),
    });
    for (const address of [w.account, keys.owner.address, w.signer.address, REVENUE, treasury]) {
      await expect(
        w.client.registerSpendKey(await w.spendKeyRequest(address)),
        address,
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(await registrations()).toBe(0);
  });

  it("checks the account binding", async () => {
    w = await World.create();
    const moved = {
      ...(await w.spendKeyRequest()),
      account_address: getAddress("0x00000000000000000000000000000000000acc03"),
    };
    await expect(w.client.registerSpendKey(moved)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("x402 and refills before a key is registered", () => {
  it("refuses both, and a refill to anything but the registered key", async () => {
    w = await World.create();
    const refill = async (to: Address) =>
      w.client.cosign(
        w.cosignRequest(await w.prepareOrCraft(w.transferCalls(to, usd(5), 0n)), {
          to,
          amount: usd(5),
          fee: 0n,
          kind: "refill",
        }),
      );
    for (const result of [await refill(keys.spendKey.address), await refill(ATTACKER)]) {
      expect(result.signature).toBeNull();
      expect(result.decision.rule_hits).toContainEqual(
        expect.objectContaining({ rule: "cosigner.spend_key_unregistered", effect: "deny" }),
      );
    }
    const authorize = await w.client.authorizeX402(x402());
    expect(authorize.decision.rule_hits).toContainEqual(
      expect.objectContaining({ rule: "cosigner.spend_key_unregistered", effect: "deny" }),
    );
    // The refused x402 call pinned nothing: registering a different key still works.
    await w.registerSpendKey(keys.otherSession.address);
    expect((await refill(keys.spendKey.address)).decision.rule_hits).toContainEqual(
      expect.objectContaining({ rule: "refill.target", effect: "deny" }),
    );
    expect((await refill(keys.otherSession.address)).decision.outcome).toBe("allow");
  });
});
