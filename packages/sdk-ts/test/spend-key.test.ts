import { readFileSync } from "node:fs";
import {
  concat,
  encodeAbiParameters,
  keccak256,
  maxUint256,
  recoverAddress,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentBankError } from "../src";
import {
  generateSessionKey,
  generateSpendKey,
  InvalidRequestError,
  PrincipalClient,
  signSpendKeyPermit,
} from "../src";
import { startFakeApi, type FakeApi } from "./helpers/fake-api";

const vectors = JSON.parse(
  readFileSync(new URL("../../core/test/vectors/vectors.json", import.meta.url), "utf8"),
) as {
  keys: { owner_private_key: Hex };
};
const owner = privateKeyToAccount(vectors.keys.owner_private_key);
const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SMART_ACCOUNT: Address = "0x1234567890123456789012345678901234567890";
const AGENT = "agt_01JABCDEFGHJKMNPQRSTVWXYZ0";

/**
 * The EIP-2612 digest exactly as USDC FiatToken computes it on-chain,
 * built by hand (typehash constants and ABI encoding), independent of the
 * SDK's typed-data object.
 */
function fiatTokenPermitDigest(input: {
  name: string;
  version: string;
  chainId: number;
  token: Address;
  owner: Address;
  spender: Address;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}): Hex {
  const domainTypehash = keccak256(
    stringToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  );
  const permitTypehash = keccak256(
    stringToBytes("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
  );
  expect(permitTypehash).toBe("0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9");
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        domainTypehash,
        keccak256(stringToBytes(input.name)),
        keccak256(stringToBytes(input.version)),
        BigInt(input.chainId),
        input.token,
      ],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [permitTypehash, input.owner, input.spender, input.value, input.nonce, input.deadline],
    ),
  );
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
}

describe("signSpendKeyPermit", () => {
  it("signs the EIP-2612 permit USDC verifies: owner = spend key, spender = account, max value and deadline", async () => {
    const spendKey = generateSpendKey().account;
    const permit = await signSpendKeyPermit({ spendKey, account: SMART_ACCOUNT, chainId: 84532, usdc: USDC });
    expect(permit).toMatchObject({
      value: maxUint256.toString(),
      deadline: maxUint256.toString(),
      nonce: "0",
    });
    const digest = fiatTokenPermitDigest({
      name: "USDC",
      version: "2",
      chainId: 84532,
      token: USDC,
      owner: spendKey.address,
      spender: SMART_ACCOUNT,
      value: maxUint256,
      nonce: 0n,
      deadline: maxUint256,
    });
    expect(await recoverAddress({ hash: digest, signature: permit.signature as Hex })).toBe(spendKey.address);
  });

  it("honors nonce, value, deadline and domain overrides", async () => {
    const spendKey = generateSpendKey().account;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const permit = await signSpendKeyPermit({
      spendKey,
      account: SMART_ACCOUNT,
      chainId: 1337,
      usdc: USDC,
      nonce: 3,
      value: "25000000",
      deadline,
      name: "USD Coin",
      version: "2",
    });
    const digest = fiatTokenPermitDigest({
      name: "USD Coin",
      version: "2",
      chainId: 1337,
      token: USDC,
      owner: spendKey.address,
      spender: SMART_ACCOUNT,
      value: 25_000_000n,
      nonce: 3n,
      deadline,
    });
    expect(permit).toMatchObject({ value: "25000000", nonce: "3", deadline: deadline.toString() });
    expect(await recoverAddress({ hash: digest, signature: permit.signature as Hex })).toBe(spendKey.address);
  });

  it("refuses zero allowances, past deadlines, self-spenders, bad addresses and mainnet chains", async () => {
    const spendKey = generateSpendKey().account;
    const base = { spendKey, account: SMART_ACCOUNT, chainId: 84532, usdc: USDC };
    await expect(signSpendKeyPermit({ ...base, value: 0 })).rejects.toThrow(/zero allowance/);
    await expect(signSpendKeyPermit({ ...base, deadline: 1 })).rejects.toThrow(/past/);
    await expect(signSpendKeyPermit({ ...base, account: spendKey.address })).rejects.toThrow(/smart account/);
    await expect(signSpendKeyPermit({ ...base, usdc: "usdc" })).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(signSpendKeyPermit({ ...base, nonce: -1 })).rejects.toThrow(/nonce/);
    const mainnet = await signSpendKeyPermit({ ...base, chainId: 8453 }).catch((e: unknown) => e);
    expect((mainnet as AgentBankError).code).toBe("mainnet_locked");
  });
});

describe("spend-key provisioning (ADR 0001)", () => {
  let api: FakeApi;

  beforeAll(async () => {
    api = await startFakeApi({ ownerAddress: owner.address });
  });

  afterAll(async () => {
    await api.close();
  });

  function principal(): PrincipalClient {
    return new PrincipalClient({ baseUrl: api.url, apiKey: "abk_test_fake", owner, validateResponses: true });
  }

  it("provisionSpendKey signs the permit for the created account's address and attaches it", async () => {
    const client = principal();
    const account = await client.accounts.create(AGENT, {});
    expect(account.spend_key_permit).toBe("none");
    const spendKey = generateSpendKey();
    const attached = await client.provisionSpendKey(account.id, spendKey.account);
    expect(attached.spend_key_address).toBe(spendKey.address);
    expect(attached.spend_key_permit).toBe("pending");
    const put = api.requests.findLast(
      (r) => r.method === "PUT" && r.url === `/v1/accounts/${account.id}/spend-key`,
    );
    const sent = JSON.parse(put?.body ?? "{}");
    expect(sent.permit).toMatchObject({ value: maxUint256.toString(), nonce: "0" });
    expect(put?.headers["idempotency-key"]).toBeDefined();
  });

  it("a permit signed by another key, or for another spender, is rejected", async () => {
    const client = principal();
    const account = await client.accounts.create(AGENT, {});
    const spendKey = generateSpendKey().account;
    const wrong = await signSpendKeyPermit({
      spendKey,
      account: SMART_ACCOUNT,
      chainId: account.chain_id,
      usdc: USDC,
    });
    const error = await client.accounts
      .attachSpendKey(account.id, { spend_key_address: spendKey.address, permit: wrong })
      .catch((e: unknown) => e);
    expect((error as AgentBankError).code).toBe("signature_invalid");
  });

  it("setupAgentAccount creates the account, attaches the spend key, then installs the first session", async () => {
    const client = principal();
    const before = api.requests.length;
    const spendKey = generateSpendKey();
    const sessionKey = generateSessionKey();
    const { account, session, installOperation } = await client.setupAgentAccount(
      {
        agentId: AGENT,
        spendKey: spendKey.account,
        session: {
          publicKey: sessionKey.address,
          scope: { max_per_tx: "25.00", max_per_day: "200.00" },
          waitForInstall: { intervalMs: 5 },
        },
      },
      { idempotencyKey: "setup-0001" },
    );
    expect(account.spend_key_address).toBe(spendKey.address);
    expect(account.spend_key_permit).toBe("executed");
    expect(session?.status).toBe("active");
    expect(installOperation?.status).toBe("succeeded");

    const writes = api.requests
      .slice(before)
      .filter((r) => r.method !== "GET")
      .map(
        (r) => `${r.method} ${r.url.replace(/[a-z]+_[0-9A-Z]{26}/g, ":id")} ${r.headers["idempotency-key"]}`,
      );
    expect(writes).toEqual([
      "POST /v1/agents/:id/accounts setup-0001.account",
      "PUT /v1/accounts/:id/spend-key setup-0001.spend-key",
      "POST /v1/sessions setup-0001.session.create",
      "POST /v1/sessions/:id/install setup-0001.session.install",
      "POST /v1/owner-operations/:id/signature setup-0001.session.sign",
    ]);
  });

  it("spendKeyPermit refuses an account on another chain than the deployment's USDC", async () => {
    const client = principal();
    const account = await client.accounts.create(AGENT, { chain: "anvil" });
    const error = await client
      .spendKeyPermit(account, privateKeyToAccount(generatePrivateKey()))
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/chain 31337/);
  });
});
