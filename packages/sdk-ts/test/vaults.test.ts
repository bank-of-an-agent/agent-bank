import { readFileSync } from "node:fs";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import {
  EARLY_WITHDRAWAL_TYPES,
  earlyWithdrawalTypedData,
  PermissionDeniedError,
  PrincipalClient,
  TIME_LOCK_VAULTS_EIP712,
} from "../src";
import { FAKE_VAULTS_CONTRACT, startFakeApi, type FakeApi, type FakeApiConfig } from "./helpers/fake-api";

const vectors = JSON.parse(
  readFileSync(new URL("../../core/test/vectors/vectors.json", import.meta.url), "utf8"),
) as {
  keys: { owner_private_key: Hex };
};
const owner = privateKeyToAccount(vectors.keys.owner_private_key);
const GOAL = "vlt_01JABCDEFGHJKMNPQRSTVWXYZ0";
const LOCKED = "vlt_01JABCDEFGHJKMNPQRSTVWXYZ1";
const UNLOCKED = "vlt_01JABCDEFGHJKMNPQRSTVWXYZ2";

const apis: FakeApi[] = [];

afterEach(async () => {
  await Promise.all(apis.splice(0).map((a) => a.close()));
});

async function setup(config: Partial<FakeApiConfig> = {}) {
  const api = await startFakeApi({
    ownerAddress: owner.address,
    vaults: [
      { id: GOAL, kind: "goal", unlock_at: null, contract_address: null, onchain_id: null },
      { id: LOCKED },
      { id: UNLOCKED, unlock_at: new Date(Date.now() - 1000).toISOString() },
    ],
    ...config,
  });
  apis.push(api);
  const client = new PrincipalClient({
    baseUrl: api.url,
    apiKey: "abk_test_fake",
    owner,
    validateResponses: true,
  });
  return { api, client };
}

describe("PrincipalClient.withdrawVault", () => {
  it("withdraws from goal vaults and unlocked locked vaults with one unsigned request", async () => {
    const { api, client } = await setup();
    for (const id of [GOAL, UNLOCKED]) {
      const before = api.requests.length;
      const vault = await client.withdrawVault(id, { amount: "5.00", asset: "USDC" });
      expect(vault.id).toBe(id);
      const sent = api.requests.slice(before);
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]?.body ?? "{}")).toEqual({ amount: { amount: "5.00", asset: "USDC" } });
    }
  });

  it("answers the EarlyWithdrawal challenge, retries with a fresh key, and signs the owner operation", async () => {
    const { api, client } = await setup();
    const before = api.requests.length;
    const vault = await client.withdrawVault(
      LOCKED,
      { amount: "12.5", asset: "USDC" },
      { idempotencyKey: "withdraw-0001", waitForInstall: { intervalMs: 5 } },
    );
    expect(vault.pending_operation_id).not.toBeNull();
    const op = api.ownerOperations.get(vault.pending_operation_id ?? "");
    expect(op).toMatchObject({ purpose: "vault.withdraw", subject_id: LOCKED, status: "succeeded" });

    const posts = api.requests
      .slice(before)
      .filter((r) => r.method === "POST" && r.url === `/v1/vaults/${LOCKED}/withdraw`);
    expect(posts.map((r) => r.headers["idempotency-key"])).toEqual([
      "withdraw-0001.withdraw",
      "withdraw-0001.withdraw-signed",
    ]);
    const signed = JSON.parse(posts[1]?.body ?? "{}");
    const deadline = BigInt(signed.owner_authorization.expires_at);
    expect(signed.owner_authorization.signer).toBe(owner.address);
    expect(Number(deadline) - Math.floor(Date.now() / 1000)).toBeGreaterThan(800);
    const recovered = await recoverTypedDataAddress({
      domain: { ...TIME_LOCK_VAULTS_EIP712, chainId: 84532, verifyingContract: FAKE_VAULTS_CONTRACT },
      types: EARLY_WITHDRAWAL_TYPES,
      primaryType: "EarlyWithdrawal",
      message: { vaultId: 7n, amount: 12_500_000n, nonce: 0n, deadline },
      signature: signed.owner_authorization.signature,
    });
    expect(recovered).toBe(owner.address);
  });

  it.each(["contract", "amount", "chain", "deadline", "domain", "vault"] as const)(
    "refuses to sign a challenge that lies about the %s",
    async (tamper) => {
      const { api, client } = await setup({ tamperEarlyWithdrawal: tamper });
      const before = api.requests.length;
      const error = await client
        .withdrawVault(LOCKED, { amount: "1.00", asset: "USDC" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PermissionDeniedError);
      expect((error as PermissionDeniedError).code).toBe("forbidden");
      const withdrawals = api.requests.slice(before).filter((r) => r.url.endsWith("/withdraw"));
      expect(withdrawals).toHaveLength(1);
      expect(api.ownerOperations.size).toBe(0);
    },
  );

  it("needs the owner key for early withdrawals", async () => {
    const { api } = await setup();
    const ownerless = new PrincipalClient({ baseUrl: api.url, apiKey: "abk_test_fake" });
    await expect(ownerless.withdrawVault(LOCKED, { amount: "1.00", asset: "USDC" })).rejects.toThrow(
      /owner key/,
    );
  });
});

describe("earlyWithdrawalTypedData", () => {
  const meta = { chain_id: 84532, contracts: { vaults: FAKE_VAULTS_CONTRACT } };
  const vault = { id: LOCKED, contract_address: FAKE_VAULTS_CONTRACT, onchain_id: "7" };
  const now = 1_790_000_000;
  const challenge = {
    domain: { ...TIME_LOCK_VAULTS_EIP712, chainId: 84532, verifyingContract: FAKE_VAULTS_CONTRACT },
    types: EARLY_WITHDRAWAL_TYPES,
    primaryType: "EarlyWithdrawal",
    message: { vaultId: "7", amount: "1000000", nonce: "2", deadline: String(now + 900) },
  };

  it("builds bigint typed data from a matching challenge", () => {
    const typed = earlyWithdrawalTypedData(challenge, { meta, vault, amountMinor: 1_000_000n, now });
    expect(typed.message).toEqual({
      vaultId: 7n,
      amount: 1_000_000n,
      nonce: 2n,
      deadline: BigInt(now + 900),
    });
    expect(typed.domain.verifyingContract).toBe(FAKE_VAULTS_CONTRACT);
  });

  it("requires the contract to match both meta.contracts.vaults and the vault", () => {
    expect(() =>
      earlyWithdrawalTypedData(challenge, {
        meta: { chain_id: 84532, contracts: { vaults: "0x5555555555555555555555555555555555555555" } },
        vault,
        amountMinor: 1_000_000n,
        now,
      }),
    ).toThrow(/verifying contract/);
    expect(() =>
      earlyWithdrawalTypedData(challenge, {
        meta: { chain_id: 84532, contracts: {} },
        vault: { ...vault, contract_address: null },
        amountMinor: 1_000_000n,
        now,
      }),
    ).toThrow(/verifying contract/);
    expect(() =>
      earlyWithdrawalTypedData(
        { ...challenge, primaryType: "Permit" },
        { meta, vault, amountMinor: 1_000_000n, now },
      ),
    ).toThrow(/EarlyWithdrawal/);
  });
});
