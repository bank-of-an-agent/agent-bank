import type { RequestInputOf } from "@agentbank/core/api";
import type {
  PaymentPayload,
  PaymentRequirements,
  ResourceInfo,
  SettleResponse,
  VerifyRequest,
  VerifyResponse,
} from "@x402/core/types";
import { describe, expect, it } from "vitest";
import type {
  SettleResponse as FacilitatorSettleResponse,
  VerifyResponse as FacilitatorVerifyResponse,
} from "../src/facilitator";

/**
 * Compile-time cross-check of the core contract against `@x402/core` 2.28's own types
 * (enforced by `tsc`, i.e. `pnpm typecheck`): what x402 clients send fits the request schema,
 * and what the facilitator answers fits x402's response types. A failing check is a type error.
 */

type Body = RequestInputOf<"x402Verify">["body"];
type Assignable<A, B> = [A] extends [B] ? true : false;
/** Compiles only when `T` is `true`. */
function holds<T extends true>(): T | undefined {
  return undefined;
}

describe("core contract vs @x402/core types", () => {
  it("x402 v2 requests fit the facilitator's request body", () => {
    holds<Assignable<PaymentRequirements, Body["paymentRequirements"]>>();
    holds<Assignable<Omit<PaymentPayload, "resource">, Omit<Body["paymentPayload"], "resource">>>();
    // x402 declares ResourceInfo as an interface, and TypeScript never assigns an interface to the
    // core's `.loose()` (index-signature) type. The fields are compatible, as a mapped copy shows,
    // and the wire format parses (interop test); typed callers spread the resource (`{ ...r }`).
    holds<
      Assignable<Pick<ResourceInfo, keyof ResourceInfo>, NonNullable<Body["paymentPayload"]["resource"]>>
    >();
    holds<
      Assignable<ResourceInfo, NonNullable<Body["paymentPayload"]["resource"]>> extends true ? false : true
    >();
    holds<Assignable<Omit<VerifyRequest, "paymentPayload">, Omit<Body, "paymentPayload">>>();
    expect(true).toBe(true);
  });

  it("facilitator answers fit x402's response types", () => {
    holds<Assignable<FacilitatorVerifyResponse, VerifyResponse>>();
    // x402 types `network` as a CAIP-2 template literal; everything else must line up.
    holds<Assignable<Omit<FacilitatorSettleResponse, "network">, Omit<SettleResponse, "network">>>();
    expect(true).toBe(true);
  });
});
