import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme as ExactEvmFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmSchemeV1 as ExactEvmFacilitatorSchemeV1 } from "@x402/evm/exact/v1/facilitator";
import { keccak256, toHex, verifyTypedData, type Hex } from "viem";
import type { FetchLike } from "../../src";

export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * A local x402 facilitator built from the **reference implementation**:
 * `x402Facilitator` (`@x402/core`) with the `exact` EVM scheme of
 * `@x402/evm` (v2 and v1). Only the chain is faked: the signer reports USDC
 * as a deployed contract, payers as EOAs, simulates/executes
 * `transferWithAuthorization` successfully and enforces single-use nonces.
 * Signature, payee, amount, time-window and domain checks are the real ones.
 */
export function createLocalFacilitator() {
  const settled: { nonce: string; from: string; to: string; value: bigint }[] = [];
  const verifications: { valid: boolean; reason: string | undefined }[] = [];
  const usedNonces = new Set<string>();
  let failSettlement = false;
  let txCounter = 0;

  const nonceOf = (args: readonly unknown[] | undefined) => String(args?.[5] ?? "").toLowerCase();

  const signer = {
    getAddresses: () => ["0x9999999999999999999999999999999999999999"] as const,
    async readContract(args: { functionName: string; args?: readonly unknown[] }): Promise<unknown> {
      if (args.functionName === "transferWithAuthorization" && usedNonces.has(nonceOf(args.args))) {
        throw new Error("FiatTokenV2: authorization is used or canceled");
      }
      if (args.functionName === "authorizationState") return false;
      if (args.functionName === "balanceOf") return 1_000_000_000n;
      return undefined;
    },
    async verifyTypedData(args: Parameters<typeof verifyTypedData>[0]): Promise<boolean> {
      return verifyTypedData(args);
    },
    async writeContract(args: { functionName: string; args: readonly unknown[] }): Promise<Hex> {
      if (failSettlement) throw new Error("execution reverted: insufficient funds");
      const nonce = nonceOf(args.args);
      if (usedNonces.has(nonce)) throw new Error("FiatTokenV2: authorization is used or canceled");
      usedNonces.add(nonce);
      settled.push({
        nonce,
        from: String(args.args[0]),
        to: String(args.args[1]),
        value: BigInt(args.args[2] as bigint),
      });
      txCounter += 1;
      return keccak256(toHex(`tx-${txCounter}-${nonce}`));
    },
    async sendTransaction(): Promise<Hex> {
      throw new Error("not supported in tests");
    },
    async waitForTransactionReceipt(): Promise<{ status: string }> {
      return { status: "success" };
    },
    async getCode(args: { address: string }): Promise<Hex | undefined> {
      return args.address.toLowerCase() === USDC_BASE_SEPOLIA.toLowerCase() ? "0x60806040" : "0x";
    },
  };

  const facilitator = new x402Facilitator()
    .register("eip155:84532", new ExactEvmFacilitatorScheme(signer))
    .registerV1("base-sepolia" as Network, new ExactEvmFacilitatorSchemeV1(signer));

  const client: FacilitatorClient = {
    async verify(payload: PaymentPayload, requirements: PaymentRequirements) {
      const result = await facilitator.verify(payload, requirements);
      verifications.push({ valid: result.isValid, reason: result.invalidReason });
      return result;
    },
    async settle(payload: PaymentPayload, requirements: PaymentRequirements) {
      return facilitator.settle(payload, requirements);
    },
    async getSupported() {
      return facilitator.getSupported() as Awaited<ReturnType<FacilitatorClient["getSupported"]>>;
    },
  };

  /** HTTP view (`POST …/verify`, `POST …/settle`) for the SDK's paywall. */
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    if (url.pathname.endsWith("/verify")) {
      return Response.json(await client.verify(body.paymentPayload, body.paymentRequirements));
    }
    if (url.pathname.endsWith("/settle")) {
      return Response.json(await client.settle(body.paymentPayload, body.paymentRequirements));
    }
    return new Response("not found", { status: 404 });
  };

  return {
    client,
    facilitator,
    fetch,
    settled,
    verifications,
    setFailSettlement(value: boolean) {
      failSettlement = value;
    },
  };
}
