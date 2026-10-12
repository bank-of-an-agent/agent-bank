import {
  canonicalSha256,
  isLockedMainnet,
  MAX_MINOR_UNITS,
  type AssetInfo,
  type ChainInfo,
} from "@agentbank/core";
import { routes, type RequestOf } from "@agentbank/core/api";
import {
  concat,
  decodeAbiParameters,
  getAddress,
  hashTypedData,
  isAddressEqual,
  numberToHex,
  recoverAddress,
  size,
  slice,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { malformed, reject, type Rejection } from "./reasons";

/**
 * The pure half of verification: request parsing, the requirement and authorization checks
 * that need no I/O, EIP-712 hashing and signature classification. Depends only on viem and the
 * core contract, so every rule here is unit-tested without a database or a chain.
 */

/** The verify/settle request body as the core contract parses it (x402 v2 `VerifyRequest`). */
export type FacilitatorRequest = RequestOf<"x402Verify">["body"];

/** EIP-712 types of EIP-3009 `TransferWithAuthorization` (identical to FiatToken v2.2's). */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Seconds an authorization must remain valid after verification (x402 reference: 6). */
export const MIN_REMAINING_VALIDITY_SECONDS = 6n;
/** Clock-skew allowance on top of `maxTimeoutSeconds` for the validity window. */
export const VALIDITY_GRACE_SECONDS = 60n;
/** ERC-6492 wrapper suffix (counterfactual contract signatures). */
export const ERC6492_MAGIC_SUFFIX = "6492649264926492649264926492649264926492649264926492649264926492";

const MAX_UINT256 = 2n ** 256n - 1n;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** FiatToken `ECRecover` refuses signatures with s above n/2 (malleable). */
const SECP256K1_HALF_N = SECP256K1_N / 2n;

/** An EIP-3009 `TransferWithAuthorization` message. */
export interface ExactAuthorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  /** 32 bytes, lowercase hex. */
  nonce: Hex;
}

/** A payment that passed the shape checks: everything typed and normalized. */
export interface ParsedPayment {
  /** CAIP-2 network as requested, e.g. `eip155:84532`. */
  network: string;
  chainId: number;
  /** Token contract (checksummed). */
  asset: Address;
  /** Required amount in atomic units. */
  amount: bigint;
  payTo: Address;
  maxTimeoutSeconds: number;
  authorization: ExactAuthorization;
  /** Signature exactly as sent. */
  signature: Hex;
  /** `authorization.from`. */
  payer: Address;
  resourceUrl: string | undefined;
}

export interface ServedChain {
  chain: ChainInfo;
  /** USDC on `chain`: address, decimals and EIP-712 domain. */
  asset: AssetInfo;
}

export interface TermsContext {
  /** Facilitator time, unix seconds. */
  nowSeconds: number;
  /** Optional global cap on one settlement, atomic units. */
  maxSettlement?: bigint | undefined;
}

type Result<T> = { ok: true; value: T } | { ok: false; rejection: Rejection };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(rejection: Rejection): Result<T> => ({ ok: false, rejection });

/** Lenient address normalization: a wrong mixed-case checksum is not a reason to refuse. */
export function normalizeAddress(value: string): Address {
  return getAddress(value.toLowerCase());
}

const Uint256String = z
  .string()
  .regex(/^[0-9]{1,78}$/, "must be a decimal integer string")
  .refine((v) => BigInt(v) <= MAX_UINT256, "must fit in uint256");

const HexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address");

/** The `exact` EVM payload, EIP-3009 flavor. The nonce length is checked separately (own reason). */
const ExactEvmPayloadSchema = z.object({
  signature: z.string().regex(/^0x([0-9a-fA-F]{2})+$/, "must be 0x-prefixed hex bytes"),
  authorization: z.object({
    from: HexAddress,
    to: HexAddress,
    value: Uint256String,
    validAfter: Uint256String,
    validBefore: Uint256String,
    nonce: z.string().regex(/^0x[0-9a-fA-F]*$/, "must be 0x-prefixed hex"),
  }),
});

function describeIssue(error: z.ZodError, prefix: string): string {
  const issue = error.issues[0];
  if (!issue) return `${prefix}: invalid`;
  const path = [prefix, ...issue.path.map(String)].filter((p) => p.length > 0).join(".");
  return `${path}: ${issue.message}`;
}

/**
 * Validate the body against the core contract (`routes.x402Verify.body`, the same schema for
 * settle). Failures are HTTP 400 answers in the x402 shape.
 */
export function parseRequestBody(body: unknown): Result<FacilitatorRequest> {
  const parsed = routes.x402Verify.body.safeParse(body);
  if (parsed.success) return ok(parsed.data);
  const first = parsed.error.issues[0];
  const reason =
    first?.path[0] === "paymentRequirements" ? "invalid_payment_requirements" : "invalid_payload";
  return fail(malformed(reason, describeIssue(parsed.error, "")));
}

/** Chain id of a CAIP-2 `eip155:<id>` network, or `undefined`. */
export function eip155ChainId(network: string): number | undefined {
  const match = /^eip155:([0-9]{1,15})$/.exec(network);
  return match ? Number(match[1]) : undefined;
}

function sameAmount(a: string, b: string): boolean {
  return BigInt(a) === BigInt(b);
}

/**
 * Checks that do not depend on time or state: protocol version, scheme, network (mainnet
 * refused), asset, amount, `accepted` == requirements, the payload shape and the nonce length.
 * The result identifies the authorization (chain, asset, payer, nonce), so settle can look up
 * an earlier attempt before re-checking anything time-dependent.
 */
export function parsePayment(request: FacilitatorRequest, served: ServedChain): Result<ParsedPayment> {
  const requirements = request.paymentRequirements;
  const accepted = request.paymentPayload.accepted;

  if (request.x402Version !== 2 || request.paymentPayload.x402Version !== 2) {
    return fail(
      reject("invalid_x402_version", `x402Version must be 2 (got ${request.paymentPayload.x402Version})`),
    );
  }
  if (requirements.scheme !== "exact") {
    return fail(
      reject("unsupported_scheme", `Scheme "${requirements.scheme}" is not supported; use "exact"`),
    );
  }
  const chainId = eip155ChainId(requirements.network);
  if (chainId === undefined) {
    return fail(
      reject("invalid_network", `Network "${requirements.network}" is not a CAIP-2 eip155 network`),
    );
  }
  if (isLockedMainnet(chainId)) {
    return fail(
      reject(
        "invalid_network",
        `${requirements.network} is a mainnet; Agent Bank is testnet-only until the Phase 5 gate`,
      ),
    );
  }
  if (chainId !== served.chain.id) {
    return fail(reject("invalid_network", `This facilitator serves ${served.chain.caip2} only`));
  }
  if (!isAddressEqual(normalizeAddress(requirements.asset), served.asset.address)) {
    return fail(
      reject(
        "unsupported_asset",
        `Asset ${requirements.asset} is not USDC on ${served.chain.caip2} (${served.asset.address})`,
      ),
    );
  }
  const amount = BigInt(requirements.amount);
  if (amount <= 0n) return fail(reject("invalid_payment_requirements", "amount must be greater than zero"));
  if (amount > MAX_MINOR_UNITS) return fail(reject("invalid_payment_requirements", "amount is out of range"));

  const mismatched = [
    accepted.scheme !== requirements.scheme ? "scheme" : undefined,
    accepted.network !== requirements.network ? "network" : undefined,
    !isAddressEqual(normalizeAddress(accepted.asset), normalizeAddress(requirements.asset))
      ? "asset"
      : undefined,
    !sameAmount(accepted.amount, requirements.amount) ? "amount" : undefined,
    !isAddressEqual(normalizeAddress(accepted.payTo), normalizeAddress(requirements.payTo))
      ? "payTo"
      : undefined,
    accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds ? "maxTimeoutSeconds" : undefined,
  ].filter((field): field is string => field !== undefined);
  if (mismatched.length > 0) {
    return fail(
      reject(
        "accepted_requirements_mismatch",
        `accepted differs from paymentRequirements in: ${mismatched.join(", ")}`,
      ),
    );
  }

  const raw = request.paymentPayload.payload;
  if (!("authorization" in raw) || !("signature" in raw)) {
    const kind = "permit2Authorization" in raw ? "Permit2" : "this";
    return fail(
      reject(
        "unsupported_payload_type",
        `${kind} payload type is not supported; send an EIP-3009 authorization`,
      ),
    );
  }
  const payload = ExactEvmPayloadSchema.safeParse(raw);
  if (!payload.success)
    return fail(reject("invalid_payload", describeIssue(payload.error, "paymentPayload.payload")));
  const auth = payload.data.authorization;
  const payer = normalizeAddress(auth.from);
  if (!/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) {
    return fail(
      reject(
        "invalid_exact_evm_payload_nonce",
        `The nonce must be 32 bytes (got ${size(auth.nonce as Hex)})`,
        payer,
      ),
    );
  }

  return ok({
    network: requirements.network,
    chainId,
    asset: served.asset.address,
    amount,
    payTo: normalizeAddress(requirements.payTo),
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    authorization: {
      from: payer,
      to: normalizeAddress(auth.to),
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce.toLowerCase() as Hex,
    },
    signature: payload.data.signature as Hex,
    payer,
    resourceUrl: request.paymentPayload.resource?.url,
  });
}

/**
 * The authorization against the requirements and the clock: recipient, exact amount, the
 * optional settlement cap, and the validity window (`validAfter <= now`,
 * `validBefore >= now + 6`, `validBefore - now <= maxTimeoutSeconds + 60`).
 */
export function checkTerms(payment: ParsedPayment, context: TermsContext): Rejection | undefined {
  const auth = payment.authorization;
  const payer = payment.payer;
  if (!isAddressEqual(auth.to, payment.payTo)) {
    return reject(
      "invalid_exact_evm_payload_recipient_mismatch",
      `authorization.to ${auth.to} is not payTo ${payment.payTo}`,
      payer,
    );
  }
  if (auth.value !== payment.amount) {
    return reject(
      "invalid_exact_evm_payload_authorization_value",
      `authorization.value ${auth.value} does not equal the required amount ${payment.amount}`,
      payer,
    );
  }
  if (context.maxSettlement !== undefined && auth.value > context.maxSettlement) {
    return reject(
      "amount_exceeds_max_settlement",
      `The amount ${auth.value} exceeds the maximum settlement ${context.maxSettlement}`,
      payer,
    );
  }
  const now = BigInt(context.nowSeconds);
  if (auth.validAfter > now) {
    return reject(
      "invalid_exact_evm_payload_authorization_valid_after",
      `The authorization is valid after ${auth.validAfter}; it is ${now}`,
      payer,
    );
  }
  if (auth.validBefore < now + MIN_REMAINING_VALIDITY_SECONDS) {
    return reject(
      "invalid_exact_evm_payload_authorization_valid_before",
      `The authorization is valid before ${auth.validBefore}; it must stay valid until at least ${now + MIN_REMAINING_VALIDITY_SECONDS}`,
      payer,
    );
  }
  const limit = BigInt(payment.maxTimeoutSeconds) + VALIDITY_GRACE_SECONDS;
  if (auth.validBefore - now > limit) {
    return reject(
      "invalid_exact_evm_payload_authorization_validity_too_long",
      `The authorization stays valid for ${auth.validBefore - now}s; at most ${limit}s (maxTimeoutSeconds + ${VALIDITY_GRACE_SECONDS}) is accepted`,
      payer,
    );
  }
  return undefined;
}

/** EIP-712 typed data of the authorization under the asset's domain (USDC: name "USDC", version "2"). */
export function authorizationTypedData(asset: AssetInfo, authorization: ExactAuthorization) {
  return {
    domain: {
      name: asset.eip712.name,
      version: asset.eip712.version,
      chainId: asset.chainId,
      verifyingContract: asset.address,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: { ...authorization },
  };
}

/** The digest USDC verifies in `transferWithAuthorization`. */
export function authorizationDigest(asset: AssetInfo, authorization: ExactAuthorization): Hex {
  return hashTypedData(authorizationTypedData(asset, authorization));
}

/** How a signature must be verified. */
export type SignatureForm =
  /** 65 bytes: ECDSA by an EOA (or a contract wallet that accepts 65-byte signatures). */
  | { kind: "ecdsa"; signature: Hex }
  /** ERC-6492 wrapper for a counterfactual wallet; `inner` is the wrapped signature (if decodable). */
  | { kind: "erc6492"; inner: Hex | undefined }
  /** Any other length: only a deployed contract wallet (ERC-1271) can accept it. */
  | { kind: "contract"; signature: Hex };

export function classifySignature(signature: Hex): SignatureForm {
  const bytes = size(signature);
  if (bytes > 32 && signature.toLowerCase().endsWith(ERC6492_MAGIC_SUFFIX)) {
    try {
      const [, , inner] = decodeAbiParameters(
        [{ type: "address" }, { type: "bytes" }, { type: "bytes" }],
        slice(signature, 0, bytes - 32),
      );
      return { kind: "erc6492", inner };
    } catch {
      return { kind: "erc6492", inner: undefined };
    }
  }
  if (bytes === 65) return { kind: "ecdsa", signature };
  return { kind: "contract", signature };
}

/**
 * A 65-byte signature in the form FiatToken's `ECRecover` accepts: `v` 27/28 (0/1 is
 * converted), `0 < r < n`, `0 < s <= n/2`. `undefined` if it can never verify on-chain.
 */
export function normalizeEcdsaSignature(signature: Hex): Hex | undefined {
  if (size(signature) !== 65) return undefined;
  const r = BigInt(slice(signature, 0, 32));
  const s = BigInt(slice(signature, 32, 64));
  let v = Number(BigInt(slice(signature, 64, 65)));
  if (v < 27) v += 27;
  if (v !== 27 && v !== 28) return undefined;
  if (r === 0n || r >= SECP256K1_N || s === 0n || s > SECP256K1_HALF_N) return undefined;
  return concat([numberToHex(r, { size: 32 }), numberToHex(s, { size: 32 }), numberToHex(v, { size: 1 })]);
}

/** The EOA that signed `digest`, with on-chain (`ECRecover`) strictness; `undefined` if none. */
export async function recoverEcdsaSigner(digest: Hex, signature: Hex): Promise<Address | undefined> {
  const normalized = normalizeEcdsaSignature(signature);
  if (!normalized) return undefined;
  try {
    return await recoverAddress({ hash: digest, signature: normalized });
  } catch {
    return undefined;
  }
}

/**
 * Fingerprint of what a settle request would do: the authorization, its signature and the
 * requirements it pays. An identical request is answered from the authorization log
 * (idempotent); any other request for the same authorization is refused.
 */
export function requestFingerprint(payment: ParsedPayment): string {
  const a = payment.authorization;
  return canonicalSha256({
    v: 1,
    scheme: "exact",
    network: payment.network,
    asset: payment.asset.toLowerCase(),
    payTo: payment.payTo.toLowerCase(),
    amount: payment.amount,
    authorization: {
      from: a.from.toLowerCase(),
      to: a.to.toLowerCase(),
      value: a.value,
      validAfter: a.validAfter,
      validBefore: a.validBefore,
      nonce: a.nonce.toLowerCase(),
    },
    signature: payment.signature.toLowerCase(),
  });
}
