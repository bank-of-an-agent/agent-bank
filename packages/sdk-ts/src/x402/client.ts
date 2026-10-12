import { assertTestnet, formatAmount, getAsset, parseAmount, type ErrorCode } from "@agentbank/core";
import type { FetchLike } from "../client";
import { AgentBankApiError, InvalidRequestError } from "../errors";
import type { Payment } from "../types";
import {
  chainIdOfNetwork,
  decodeHeaderValue,
  encodeHeaderValue,
  PaymentRequiredSchema,
  PaymentRequiredV1Schema,
  PaymentRequirementsSchema,
  PaymentRequirementsV1Schema,
  readPaymentResponse,
  X402_HEADERS,
  type ExactEvmPayload,
  type PaymentPayload,
  type PaymentPayloadV1,
  type PaymentRequirements,
  type ResourceInfo,
  type SettleResponse,
} from "./protocol";

/**
 * x402 buyer: a `fetch` that pays HTTP 402 challenges.
 *
 * On a 402 the client parses the challenge (v2 `PAYMENT-REQUIRED` header, or
 * a v1 JSON body), picks an `exact` USDC requirement on the configured
 * network that fits under `maxAmountPerRequest`, asks an {@link X402Payer}
 * for the signed EIP-3009 payload, retries the request once with the payment
 * header (`PAYMENT-SIGNATURE` for v2, `X-PAYMENT` for v1) and surfaces the
 * seller's settlement (`PAYMENT-RESPONSE`).
 *
 * @packageDocumentation
 */

/** USDC decimals (the only asset in v1). */
const USDC_DECIMALS = 6;

/** Default network: Base Sepolia. */
export const DEFAULT_X402_NETWORK = "eip155:84532";
/** Default client-side cap per request: 1.00 USDC (same default as the reference x402 client). */
export const DEFAULT_MAX_AMOUNT_PER_REQUEST = "1.00";

/** Why an x402 payment could not be made. */
export type X402ErrorReason =
  | "invalid_challenge"
  | "no_acceptable_requirement"
  | "amount_exceeds_limit"
  | "approval_required"
  | "authorization_mismatch"
  | "payment_rejected"
  | "spend_key_missing"
  | "unexpected_status";

const CODE_BY_REASON: Record<X402ErrorReason, ErrorCode> = {
  invalid_challenge: "invalid_request",
  no_acceptable_requirement: "invalid_request",
  amount_exceeds_limit: "policy_denied",
  approval_required: "policy_denied",
  authorization_mismatch: "internal",
  payment_rejected: "conflict",
  spend_key_missing: "invalid_request",
  unexpected_status: "internal",
};

/** An x402 payment failed on the client side or was rejected by the seller. */
export class X402Error extends AgentBankApiError {
  /** Machine-readable reason. */
  readonly reason: X402ErrorReason;
  /** The Agent Bank payment, if one was created (its hold expires if the seller never settles). */
  readonly payment: Payment | undefined;
  /** The seller's settlement response, if any. */
  readonly settlement: SettleResponse | undefined;
  /** The seller's last HTTP response, if any. */
  readonly response: Response | undefined;

  constructor(
    reason: X402ErrorReason,
    detail: string,
    context: { payment?: Payment; settlement?: SettleResponse; response?: Response } = {},
  ) {
    super(CODE_BY_REASON[reason], detail, { reason });
    this.reason = reason;
    this.payment = context.payment;
    this.settlement = context.settlement;
    this.response = context.response;
  }
}

/** A parsed 402 challenge. */
export interface X402Challenge {
  /** Protocol version of the challenge. */
  version: 1 | 2;
  /** The decoded challenge exactly as received. */
  raw: Record<string, unknown>;
  /** The server's error string (e.g. why a previous payment was refused). */
  error: string | undefined;
  /** v2 resource info (v1 carries it per requirement). */
  resource: ResourceInfo | undefined;
  /** v2 extensions to echo back. */
  extensions: Record<string, unknown> | undefined;
  /** Raw `accepts` entries. */
  accepts: Record<string, unknown>[];
}

/** The requirement the client chose to pay. */
export interface SelectedRequirement {
  /** Protocol version of the challenge it came from. */
  version: 1 | 2;
  /** The requirement exactly as the server sent it (echoed back in `accepted`). */
  raw: Record<string, unknown>;
  scheme: "exact";
  /** Network as sent (CAIP-2 for v2, a name like `base-sepolia` for v1). */
  network: string;
  /** CAIP-2 form of the network. */
  caip2Network: string;
  chainId: number;
  asset: string;
  /** Price in atomic units (USDC: 6 decimals). */
  amount: bigint;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
  /** Resource info to report to the payer (description, MIME type). */
  resource: ResourceInfo | undefined;
}

/** What an {@link X402Payer} receives. */
export interface X402PaymentContext {
  /** URL of the request being paid for (the real one, not the server's claim). */
  requestUrl: string;
  /** HTTP method of the request. */
  method: string;
  challenge: X402Challenge;
  requirement: SelectedRequirement;
  /** The USDC EIP-712 domain name/version the authorization must use, when known. */
  expectedDomain?: { name: string; version: string };
}

/** Produces the signed `exact` payload for a selected requirement. */
export interface X402Payer {
  pay(context: X402PaymentContext): Promise<{ payload: ExactEvmPayload; payment?: Payment }>;
}

/** Details of a paid request. */
export interface X402PaymentEvent {
  requestUrl: string;
  /** Amount paid as a decimal USDC string, e.g. `"0.01"`. */
  amount: string;
  requirement: SelectedRequirement;
  payment: Payment | undefined;
  settlement: SettleResponse | undefined;
}

/** Client-side x402 settings. */
export interface X402ClientOptions {
  /**
   * CAIP-2 network to pay on. Mainnets are refused. `AgentClient` resolves it
   * from `GET /v1/meta` when unset; the standalone {@link wrapFetch} and
   * {@link fetchWithX402} default to `eip155:84532` (Base Sepolia).
   */
  network?: string;
  /**
   * USDC contract on that network: the only asset paid. Defaults to Agent
   * Bank's asset registry for the chain (`AgentClient`: `meta.usdc.address`).
   */
  usdc?: string;
  /**
   * USDC's EIP-712 domain name and version (`meta.usdc.eip712_name` /
   * `eip712_version`). When known, the authorization Agent Bank returns must
   * use exactly this domain.
   */
  usdcDomain?: { name: string; version: string };
  /**
   * Hard cap per request as a decimal USDC string (default `"1.00"`).
   * Defense in depth on top of the server-side policy: a challenge above the
   * cap is refused before Agent Bank is even asked.
   */
  maxAmountPerRequest?: string;
  /** Called after every successful payment. */
  onPayment?: (event: X402PaymentEvent) => void | Promise<void>;
}

/** Options of {@link wrapFetch}. */
export interface WrapFetchOptions extends X402ClientOptions {
  payer: X402Payer;
  /**
   * Resolve the settings lazily, only once a 402 has to be paid (free
   * resources then cost no extra round trip). `AgentClient` uses this to read
   * the deployment's network and USDC from `GET /v1/meta`. When set, the
   * static `network` / `usdc` / `usdcDomain` / `maxAmountPerRequest` are ignored.
   */
  resolveSettings?: () => Promise<ResolvedX402Options>;
}

/** Result of {@link fetchWithX402}. */
export interface X402FetchResult {
  /** The final response (the paid retry, or the first response if no payment was needed). */
  response: Response;
  /**
   * Whether a signed payment was sent with the retried request. `settlement`
   * tells whether the seller settled it (a seller that fails after
   * verification may not settle; the authorization then simply expires).
   */
  paid: boolean;
  /** Amount paid as a decimal USDC string. */
  amount?: string;
  requirement?: SelectedRequirement;
  /** The Agent Bank payment record (kind `x402`). */
  payment?: Payment;
  /** The seller's settlement response (`PAYMENT-RESPONSE`). */
  settlement?: SettleResponse;
}

/** Fully resolved x402 client settings. */
export interface ResolvedX402Options {
  network: string;
  chainId: number;
  usdc: string;
  usdcDomain: { name: string; version: string } | undefined;
  maxAmount: bigint;
}

/**
 * Validate a CAIP-2 `eip155:<chainId>` network and return its chain id.
 * Throws `invalid_request` for other formats and `mainnet_locked` for mainnets.
 */
export function x402ChainId(network: string): number {
  const chainId = /^eip155:[0-9]+$/.test(network) ? chainIdOfNetwork(network) : undefined;
  if (chainId === undefined) {
    throw new InvalidRequestError(
      "invalid_request",
      `x402 network must be CAIP-2 eip155:<chainId>, got "${network}"`,
    );
  }
  assertTestnet(chainId);
  return chainId;
}

/** Parse the per-request cap (decimal USDC, an optional leading `$`) into minor units. */
export function parseX402Cap(maxAmountPerRequest: string | undefined): bigint {
  return parseAmount(
    (maxAmountPerRequest ?? DEFAULT_MAX_AMOUNT_PER_REQUEST).replace(/^\$/, ""),
    USDC_DECIMALS,
  );
}

/** Validate and resolve client options (throws on mainnets, unknown USDC and malformed caps). */
export function resolveX402Options(options: X402ClientOptions = {}): ResolvedX402Options {
  const network = options.network ?? DEFAULT_X402_NETWORK;
  const chainId = x402ChainId(network);
  let usdc = options.usdc;
  let usdcDomain = options.usdcDomain;
  if (usdc === undefined) {
    const asset = getAsset(chainId, "USDC");
    usdc = asset.address;
    usdcDomain ??= { name: asset.eip712.name, version: asset.eip712.version };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(usdc)) {
    throw new InvalidRequestError("invalid_request", "x402 usdc must be a 0x-prefixed address");
  }
  return { network, chainId, usdc, usdcDomain, maxAmount: parseX402Cap(options.maxAmountPerRequest) };
}

/** Parse a 402 response into a challenge; `undefined` if it is not an x402 challenge. */
export async function parseChallenge(response: Response): Promise<X402Challenge | undefined> {
  const header = response.headers.get(X402_HEADERS.paymentRequired);
  if (header) {
    let decoded: unknown;
    try {
      decoded = decodeHeaderValue(header);
    } catch {
      throw new X402Error("invalid_challenge", "PAYMENT-REQUIRED header is not valid base64 JSON", {
        response,
      });
    }
    const parsed = PaymentRequiredSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new X402Error("invalid_challenge", "PAYMENT-REQUIRED header is not an x402 v2 challenge", {
        response,
      });
    }
    const { resource, extensions, error, accepts } = parsed.data;
    return {
      version: 2,
      raw: decoded as Record<string, unknown>,
      error,
      resource: resource as ResourceInfo,
      extensions,
      accepts,
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(await response.clone().text());
  } catch {
    return undefined;
  }
  const v1 = PaymentRequiredV1Schema.safeParse(body);
  if (!v1.success) return undefined;
  return {
    version: 1,
    raw: body as Record<string, unknown>,
    error: v1.data.error,
    resource: undefined,
    extensions: undefined,
    accepts: v1.data.accepts,
  };
}

function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * Pick the cheapest acceptable requirement: scheme `exact`, the configured
 * network, Agent Bank's USDC on that network, EIP-3009 transfer method, and
 * a price within the cap.
 */
export function selectRequirement(
  challenge: X402Challenge,
  options: ResolvedX402Options,
): SelectedRequirement {
  const candidates: SelectedRequirement[] = [];
  for (const entry of challenge.accepts) {
    const candidate = toCandidate(challenge, entry);
    if (!candidate) continue;
    if (candidate.scheme !== "exact" || candidate.chainId !== options.chainId) continue;
    if (!sameAddress(candidate.asset, options.usdc)) continue;
    const method = candidate.extra.assetTransferMethod;
    if (method !== undefined && method !== "eip3009" && method !== "default") continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(candidate.payTo) || candidate.amount <= 0n) continue;
    candidates.push(candidate);
  }
  if (candidates.length === 0) {
    throw new X402Error(
      "no_acceptable_requirement",
      `No acceptable x402 payment option: need scheme "exact", USDC on ${options.network}`,
    );
  }
  candidates.sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
  const cheapest = candidates[0] as SelectedRequirement;
  if (cheapest.amount > options.maxAmount) {
    throw new X402Error(
      "amount_exceeds_limit",
      `Price ${formatAmount(cheapest.amount, USDC_DECIMALS)} USDC exceeds maxAmountPerRequest ${formatAmount(options.maxAmount, USDC_DECIMALS)} USDC`,
    );
  }
  return cheapest;
}

function toCandidate(
  challenge: X402Challenge,
  entry: Record<string, unknown>,
): SelectedRequirement | undefined {
  if (challenge.version === 2) {
    const parsed = PaymentRequirementsSchema.safeParse(entry);
    if (!parsed.success) return undefined;
    const r = parsed.data;
    const chainId = chainIdOfNetwork(r.network);
    if (chainId === undefined || r.scheme !== "exact") return undefined;
    return {
      version: 2,
      raw: entry,
      scheme: "exact",
      network: r.network,
      caip2Network: `eip155:${chainId}`,
      chainId,
      asset: r.asset,
      amount: BigInt(r.amount),
      payTo: r.payTo,
      maxTimeoutSeconds: r.maxTimeoutSeconds,
      extra: r.extra ?? {},
      resource: challenge.resource,
    };
  }
  const parsed = PaymentRequirementsV1Schema.safeParse(entry);
  if (!parsed.success) return undefined;
  const r = parsed.data;
  const chainId = chainIdOfNetwork(r.network);
  if (chainId === undefined || r.scheme !== "exact") return undefined;
  const resource: ResourceInfo = { url: r.resource };
  if (r.description) resource.description = r.description;
  if (r.mimeType) resource.mimeType = r.mimeType;
  return {
    version: 1,
    raw: entry,
    scheme: "exact",
    network: r.network,
    caip2Network: `eip155:${chainId}`,
    chainId,
    asset: r.asset,
    amount: BigInt(r.maxAmountRequired),
    payTo: r.payTo,
    maxTimeoutSeconds: r.maxTimeoutSeconds,
    extra: r.extra ?? {},
    resource,
  };
}

/** Build the payment header (name and value) for a signed payload. */
export function buildPaymentHeader(
  challenge: X402Challenge,
  requirement: SelectedRequirement,
  payload: ExactEvmPayload,
): { name: string; value: string; payload: PaymentPayload | PaymentPayloadV1 } {
  if (requirement.version === 2) {
    const body: PaymentPayload = {
      x402Version: 2,
      ...(challenge.resource ? { resource: challenge.resource } : {}),
      accepted: requirement.raw as PaymentRequirements,
      payload,
      ...(challenge.extensions ? { extensions: challenge.extensions } : {}),
    };
    return { name: X402_HEADERS.paymentSignature, value: encodeHeaderValue(body), payload: body };
  }
  const body: PaymentPayloadV1 = {
    x402Version: 1,
    scheme: requirement.scheme,
    network: requirement.network,
    payload,
  };
  return { name: X402_HEADERS.v1Payment, value: encodeHeaderValue(body), payload: body };
}

async function rejectionReason(response: Response, settlement: SettleResponse | undefined): Promise<string> {
  try {
    const again = await parseChallenge(response);
    if (again?.error) return again.error;
  } catch {
    // fall through to the settlement reason
  }
  return settlement?.errorReason ?? `HTTP ${response.status}`;
}

/**
 * Perform `fetch(input, init)`, paying an x402 challenge if the response is
 * a 402. The request body is buffered so the paid retry can resend it. When
 * the 402 came after redirects, the payment (and Agent Bank's policy check of
 * the seller's domain) applies to the final URL, and the paid retry goes there.
 *
 * Throws {@link X402Error} when the challenge cannot be paid (no acceptable
 * option, over the cap, approval required) or the seller rejects the payment;
 * API errors (e.g. `PolicyDeniedError`) propagate from the payer.
 */
export async function fetchWithX402(
  fetchImpl: FetchLike,
  input: string | URL | Request,
  init: RequestInit | undefined,
  options: WrapFetchOptions,
): Promise<X402FetchResult> {
  const eager = options.resolveSettings ? undefined : resolveX402Options(options);
  const original = new Request(input, init);
  const body = original.body ? new Uint8Array(await original.clone().arrayBuffer()) : undefined;
  const replay = (headers: Headers, url: string = original.url) =>
    new Request(url, {
      method: original.method,
      headers,
      ...(body ? { body } : {}),
      signal: original.signal,
      redirect: original.redirect,
      credentials: original.credentials,
    });

  const first = await fetchImpl(replay(new Headers(original.headers)));
  if (first.status !== 402) return { response: first, paid: false };
  const challenge = await parseChallenge(first);
  if (!challenge) return { response: first, paid: false };

  // Pay (and let policy judge) the origin that actually asked for payment: after
  // redirects that is the final URL, not the one the caller started from.
  const paidUrl = first.url || original.url;
  const resolved = eager ?? (await (options.resolveSettings as () => Promise<ResolvedX402Options>)());
  const requirement = selectRequirement(challenge, resolved);
  const { payload, payment } = await options.payer.pay({
    requestUrl: paidUrl,
    method: original.method,
    challenge,
    requirement,
    ...(resolved.usdcDomain ? { expectedDomain: resolved.usdcDomain } : {}),
  });
  const header = buildPaymentHeader(challenge, requirement, payload);
  const headers = new Headers(original.headers);
  headers.set(header.name, header.value);
  // Drain the 402 body so the connection can be reused.
  await first.body?.cancel().catch(() => undefined);

  const second = await fetchImpl(replay(headers, paidUrl));
  const settlement = readPaymentResponse(second);
  const amount = formatAmount(requirement.amount, USDC_DECIMALS);
  if (second.status === 402) {
    throw new X402Error(
      "payment_rejected",
      `Seller rejected the x402 payment: ${await rejectionReason(second, settlement)}`,
      { ...(payment ? { payment } : {}), ...(settlement ? { settlement } : {}), response: second },
    );
  }
  await options.onPayment?.({ requestUrl: paidUrl, amount, requirement, payment, settlement });
  return {
    response: second,
    paid: true,
    amount,
    requirement,
    ...(payment ? { payment } : {}),
    ...(settlement ? { settlement } : {}),
  };
}

/**
 * Wrap a `fetch` so it pays x402 challenges through `options.payer`.
 *
 * @example
 * ```ts
 * const paidFetch = wrapFetch(fetch, { payer: agent.x402Payer, maxAmountPerRequest: "0.10" });
 * const res = await paidFetch("https://api.example-data.com/report");
 * console.log(readPaymentResponse(res)?.transaction);
 * ```
 */
export function wrapFetch(fetchImpl: FetchLike, options: WrapFetchOptions): FetchLike {
  if (!options.resolveSettings) resolveX402Options(options);
  return async (input, init) => (await fetchWithX402(fetchImpl, input, init, options)).response;
}
