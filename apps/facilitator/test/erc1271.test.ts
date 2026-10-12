import { accountFactoryArgs, type AccountDeployment } from "@agentbank/chain";
import { usdc } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import { createTestDatabase } from "@agentbank/db/testing";
import { concat, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorizationDigest } from "../src/verification";
import {
  buildPayment,
  contractWalletSignature,
  createHarness,
  deployContractWallet,
  erc6492Wrap,
  seller,
  stranger,
  walletCosigner,
  walletOwner,
} from "./helpers";

/**
 * Contract-wallet payers. Agent Bank buyers pay from EOA spend keys (ADR 0001), but the
 * facilitator also serves deployed contract wallets through ERC-1271 (USDC v2.2 verifies them
 * with `isValidSignature`, via the bytes-signature overload), and refuses undeployed
 * (ERC-6492-only) wallets with `payer_not_deployed`: USDC cannot deploy them.
 * The simulator's Safe7579 accounts implement ERC-1271 like production (validator ‖ signature).
 */

let db: SqlClient;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

describe("deployed contract wallet (ERC-1271)", () => {
  it("verifies and settles, moving funds from the wallet", async () => {
    const h = createHarness(db);
    const wallet = await deployContractWallet(h.chain, { fund: usdc("20") });
    expect(await h.chain.gateway.isDeployed(wallet)).toBe(true);
    const { body } = await buildPayment(h, {
      from: wallet,
      amount: usdc("4"),
      signature: (auth) => contractWalletSignature(h.chain, authorizationDigest(h.asset, auth)),
    });

    expect((await h.facilitator.verify(body)).body).toEqual({ isValid: true, payer: wallet });
    const out = await h.facilitator.settle(body);
    expect(out.body).toMatchObject({ success: true, payer: wallet, amount: usdc("4").toString() });
    expect(h.chain.balanceOf(wallet)).toBe(usdc("16"));
    expect(h.chain.balanceOf(seller)).toBe(usdc("4"));
    const { rows } = await db.query<{ authorizer: string; status: string }>(
      "SELECT authorizer, status FROM x402_authorization WHERE tx_hash = $1",
      [out.body.transaction],
    );
    expect(rows).toEqual([{ authorizer: wallet, status: "settled" }]);
  });

  it("refuses a signature the wallet does not accept (wrong owner)", async () => {
    const h = createHarness(db);
    const wallet = await deployContractWallet(h.chain, { salt: 8n });
    const { body } = await buildPayment(h, {
      from: wallet,
      signature: (auth) => contractWalletSignature(h.chain, authorizationDigest(h.asset, auth), stranger),
    });
    const out = await h.facilitator.verify(body);
    expect(out.body).toMatchObject({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature" });
    expect(out.body.invalidMessage).toMatch(/ERC-1271/);
    expect((await h.facilitator.settle(body)).body.errorReason).toBe("invalid_exact_evm_payload_signature");
  });

  it("refuses an EOA-style signature for a deployed wallet with payer_has_code (USDC asks the wallet)", async () => {
    const h = createHarness(db);
    const wallet = await deployContractWallet(h.chain, { salt: 9n });
    const { body } = await buildPayment(h, {
      from: wallet,
      signature: (auth) => walletOwner.sign({ hash: authorizationDigest(h.asset, auth) }),
    });
    const out = await h.facilitator.verify(body);
    expect(out.body).toMatchObject({ isValid: false, invalidReason: "payer_has_code", payer: wallet });
    expect(out.body.invalidMessage).toMatch(/ERC-1271/);
  });

  it("accepts an ERC-6492 wrapper once the wallet is deployed and settles with the inner signature", async () => {
    const h = createHarness(db);
    const deployment: AccountDeployment = {
      owner: walletOwner.address,
      cosigner: walletCosigner.address,
      salt: 10n,
    };
    const wallet = await deployContractWallet(h.chain, { salt: deployment.salt });
    const { factory, factoryData } = accountFactoryArgs(deployment, h.chain.contracts);
    const { body } = await buildPayment(h, {
      from: wallet,
      signature: async (auth) =>
        erc6492Wrap(
          factory,
          factoryData,
          await contractWalletSignature(h.chain, authorizationDigest(h.asset, auth)),
        ),
    });
    expect((await h.facilitator.verify(body)).body.isValid).toBe(true);
    const out = await h.facilitator.settle(body);
    expect(out.body.success).toBe(true);
    expect(h.chain.balanceOf(seller)).toBe(usdc("0.01"));
  });
});

describe("undeployed (counterfactual) contract wallet", () => {
  async function counterfactual(salt: bigint) {
    const h = createHarness(db);
    const deployment: AccountDeployment = {
      owner: walletOwner.address,
      cosigner: walletCosigner.address,
      salt,
    };
    const wallet = await h.chain.gateway.predictAccountAddress(deployment);
    h.chain.faucet(wallet, usdc("20")); // counterfactual addresses can receive funds
    expect(await h.chain.gateway.isDeployed(wallet)).toBe(false);
    return { h, wallet, deployment };
  }

  it("is refused with payer_not_deployed for an ERC-6492 signature (even one the wallet would accept)", async () => {
    const { h, wallet, deployment } = await counterfactual(21n);
    const { factory, factoryData } = accountFactoryArgs(deployment, h.chain.contracts);
    const { body } = await buildPayment(h, {
      from: wallet,
      signature: async (auth) =>
        erc6492Wrap(
          factory,
          factoryData,
          await contractWalletSignature(h.chain, authorizationDigest(h.asset, auth)),
        ),
    });
    // The gateway alone would accept it (ERC-6492 simulation); USDC would not.
    const digest = authorizationDigest(h.asset, {
      from: wallet,
      to: seller,
      value: BigInt(body.paymentRequirements.amount),
      validAfter: BigInt(
        (body.paymentPayload.payload as { authorization: { validAfter: string } }).authorization.validAfter,
      ),
      validBefore: BigInt(
        (body.paymentPayload.payload as { authorization: { validBefore: string } }).authorization.validBefore,
      ),
      nonce: (body.paymentPayload.payload as { authorization: { nonce: Hex } }).authorization.nonce,
    });
    const signature = (body.paymentPayload.payload as { signature: Hex }).signature;
    expect(await h.chain.gateway.verifySignature({ address: wallet, hash: digest, signature })).toBe(true);

    const verify = await h.facilitator.verify(body);
    expect(verify.body).toMatchObject({ isValid: false, invalidReason: "payer_not_deployed", payer: wallet });
    const settle = await h.facilitator.settle(body);
    expect(settle.body).toMatchObject({ success: false, errorReason: "payer_not_deployed" });
    expect(h.chain.balanceOf(wallet)).toBe(usdc("20"));
  });

  it("is refused with payer_not_deployed for a raw contract signature", async () => {
    const { h, wallet } = await counterfactual(22n);
    const { body } = await buildPayment(h, {
      from: wallet,
      signature: (auth) => contractWalletSignature(h.chain, authorizationDigest(h.asset, auth)),
    });
    expect((await h.facilitator.verify(body)).body.invalidReason).toBe("payer_not_deployed");
  });

  it("a 65-byte owner signature for the counterfactual address is just a wrong signer", async () => {
    const { h, wallet } = await counterfactual(23n);
    const { body } = await buildPayment(h, {
      from: wallet,
      signature: (auth) => walletOwner.sign({ hash: authorizationDigest(h.asset, auth) }),
    });
    const out = await h.facilitator.verify(body);
    expect(out.body.invalidReason).toBe("invalid_exact_evm_payload_signature");
    expect(out.body.invalidMessage).toContain(walletOwner.address);
  });

  it("refuses a malformed ERC-6492 wrapper", async () => {
    const h = createHarness(db);
    const wallet = await deployContractWallet(h.chain, { salt: 24n });
    const { body } = await buildPayment(h, {
      from: wallet,
      signature: concat(["0xdeadbeef", `0x${"6492".repeat(16)}`]),
    });
    expect((await h.facilitator.verify(body)).body.invalidReason).toBe("invalid_exact_evm_payload_signature");
  });
});
