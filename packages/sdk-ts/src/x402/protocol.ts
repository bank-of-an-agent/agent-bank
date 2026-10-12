import { CHAINS, bytesToBase64, base64ToBytes, utf8 } from "@agentbank/core";
import { z } from "zod";

/**
 * x402 wire format (protocol versions 2 and 1), as implemented by the
 * reference `@x402/core` package (verified against v2.28.0):
 *
 * | Direction | v2 header | v1 |
 * | --- | --- | --- |
 * | 402 challenge (server → client) | `PAYMENT-REQUIRED`: base64(JSON `PaymentRequired`) | JSON response body `{ x402Version: 1, accepts: [...] }` |
 * | payment (client → server) | `PAYMENT-SIGNATURE`: base64(JSON `PaymentPayload`) | `X-PAYMENT`: base64(JSON) |
 * | settlement (server → client) | `PAYMENT-RESPONSE`: base64(JSON `SettleResponse`) | `X-PAYMENT-RESPONSE` |
 *
 * Base64 is the standard alphabet with padding over the UTF-8 JSON text.
 * The `exact` EVM scheme payload is
 * `{ signature, authorization: { from, to, value, validAfter, validBefore, nonce } }`
 * with every integer as a decimal string: an EIP-3009 `TransferWithAuthorization`.
 *
 * @packageDocumentation
 */

/** Header names (HTTP header names are case-insensitive; these are the spec spellings). */
export const X402_HEADERS = {
  /** v2 challenge: base64 JSON `PaymentRequired`. */
  paymentRequired: "PAYMENT-REQUIRED",
  /** v2 payment: base64 JSON `PaymentPayload`. */
  paymentSignature: "PAYMENT-SIGNATURE",
  /** v2 settlement: base64 JSON `SettleResponse`. */
  paymentResponse: "PAYMENT-RESPONSE",
  /** v1 payment header. */
  v1Payment: "X-PAYMENT",
  /** v1 settlement header. */
  v1PaymentResponse: "X-PAYMENT-RESPONSE",
} as const;

/** Description of the paid resource. */
export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  [extension: string]: unknown;
}

/** x402 v2 `PaymentRequirements`: one way to pay. Amounts are atomic token units. */
export interface PaymentRequirements {
  scheme: string;
  /** CAIP-2 network, e.g. `"eip155:84532"`. */
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
  [extension: string]: unknown;
}

/** x402 v2 `PaymentRequired` (the 402 challenge). */
export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** x402 v1 `PaymentRequirements` (network names like `"base-sepolia"`, `maxAmountRequired`). */
export interface PaymentRequirementsV1 {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  outputSchema?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  [extension: string]: unknown;
}

/** x402 v1 challenge (sent as the JSON body of the 402). */
export interface PaymentRequiredV1 {
  x402Version: 1;
  error?: string;
  accepts: PaymentRequirementsV1[];
}

/** EIP-3009 `TransferWithAuthorization` fields, all integers as decimal strings. */
export interface ExactEvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** The `exact` EVM scheme payload (EIP-3009 flavor). */
export interface ExactEvmPayload {
  signature: string;
  authorization: ExactEvmAuthorization;
}

/** x402 v2 `PaymentPayload` (sent in `PAYMENT-SIGNATURE`). */
export interface PaymentPayload {
  x402Version: 2;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: ExactEvmPayload;
  extensions?: Record<string, unknown>;
}

/** x402 v1 payment payload (sent in `X-PAYMENT`). */
export interface PaymentPayloadV1 {
  x402Version: 1;
  scheme: string;
  network: string;
  payload: ExactEvmPayload;
}

/** Facilitator settlement result (sent back in `PAYMENT-RESPONSE`). */
export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
  [extension: string]: unknown;
}

/** Facilitator verification result. */
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
  [extension: string]: unknown;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Encode a value as base64 (standard alphabet) of its UTF-8 JSON, the x402 header encoding. */
export function encodeHeaderValue(value: unknown): string {
  return bytesToBase64(utf8(JSON.stringify(value)));
}

/** Decode an x402 header value. Throws on invalid base64 or JSON. */
export function decodeHeaderValue(value: string): unknown {
  const trimmed = value.trim();
  if (!BASE64_RE.test(trimmed)) throw new SyntaxError("x402 header is not base64");
  return JSON.parse(new TextDecoder().decode(base64ToBytes(trimmed)));
}

const AtomicAmount = z.string().regex(/^[0-9]+$/);

/** Lenient schemas for untrusted challenges: unknown fields are kept (they must be echoed back). */
export const PaymentRequirementsSchema = z
  .object({
    scheme: z.string().min(1),
    network: z.string().min(1),
    asset: z.string().min(1),
    amount: AtomicAmount,
    payTo: z.string().min(1),
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

/** Lenient schema of an x402 v1 requirement (unknown fields kept). */
export const PaymentRequirementsV1Schema = z
  .object({
    scheme: z.string().min(1),
    network: z.string().min(1),
    maxAmountRequired: AtomicAmount,
    resource: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    payTo: z.string().min(1),
    maxTimeoutSeconds: z.number().int().positive(),
    asset: z.string().min(1),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

/** Lenient schema of an x402 v2 challenge (`PAYMENT-REQUIRED`). */
export const PaymentRequiredSchema = z
  .object({
    x402Version: z.literal(2),
    error: z.string().optional(),
    resource: z.object({ url: z.string() }).loose(),
    accepts: z.array(z.record(z.string(), z.unknown())),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

/** Lenient schema of an x402 v1 challenge (402 JSON body). */
export const PaymentRequiredV1Schema = z
  .object({
    x402Version: z.literal(1),
    error: z.string().optional(),
    accepts: z.array(z.record(z.string(), z.unknown())),
  })
  .loose();

const AuthorizationSchema = z.object({
  from: z.string(),
  to: z.string(),
  value: AtomicAmount,
  validAfter: AtomicAmount,
  validBefore: AtomicAmount,
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

/** Schema of the `exact` EVM (EIP-3009) payload: signature plus authorization. */
export const ExactEvmPayloadSchema = z.object({
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  authorization: AuthorizationSchema,
});

/** Schema of an x402 v2 `PaymentPayload` (`PAYMENT-SIGNATURE`). */
export const PaymentPayloadSchema = z
  .object({
    x402Version: z.literal(2),
    resource: z.object({ url: z.string() }).loose().optional(),
    accepted: PaymentRequirementsSchema,
    payload: ExactEvmPayloadSchema,
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

/** Schema of an x402 v1 payment payload (`X-PAYMENT`). */
export const PaymentPayloadV1Schema = z
  .object({
    x402Version: z.literal(1),
    scheme: z.string(),
    network: z.string(),
    payload: ExactEvmPayloadSchema,
  })
  .loose();

/** Schema of a facilitator settlement response (`PAYMENT-RESPONSE`). */
export const SettleResponseSchema = z
  .object({
    success: z.boolean(),
    errorReason: z.string().optional(),
    errorMessage: z.string().optional(),
    payer: z.string().optional(),
    transaction: z.string(),
    network: z.string(),
    amount: z.string().optional(),
  })
  .loose();

/** Read the settlement (`PAYMENT-RESPONSE`, or v1 `X-PAYMENT-RESPONSE`) from a paid response. */
export function readPaymentResponse(response: Response | Headers): SettleResponse | undefined {
  const headers: Headers = "headers" in response ? response.headers : response;
  const value = headers.get(X402_HEADERS.paymentResponse) ?? headers.get(X402_HEADERS.v1PaymentResponse);
  if (!value) return undefined;
  try {
    const parsed = SettleResponseSchema.safeParse(decodeHeaderValue(value));
    return parsed.success ? (parsed.data as SettleResponse) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Chain id of an x402 network: CAIP-2 `eip155:<id>` (v2) or a v1 network
 * name known to Agent Bank (`"base-sepolia"`). `undefined` if unknown.
 */
export function chainIdOfNetwork(network: string): number | undefined {
  const caip = /^eip155:([0-9]+)$/.exec(network);
  if (caip) return Number(caip[1]);
  return Object.values(CHAINS).find((c) => c.x402Network === network)?.id;
}

/** The v1 network name for a chain id (e.g. 84532 → `"base-sepolia"`). */
export function v1NetworkOf(chainId: number): string | undefined {
  return Object.values(CHAINS).find((c) => c.id === chainId)?.x402Network;
}
