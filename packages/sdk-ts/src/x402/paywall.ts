import { assertTestnet, formatAmount, getAsset, parseAmount } from "@agentbank/core";
import type { FetchLike } from "../client";
import { InvalidRequestError } from "../errors";
import {
  chainIdOfNetwork,
  decodeHeaderValue,
  encodeHeaderValue,
  PaymentPayloadSchema,
  PaymentPayloadV1Schema,
  SettleResponseSchema,
  v1NetworkOf,
  X402_HEADERS,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequiredV1,
  type PaymentRequirements,
  type PaymentRequirementsV1,
  type ResourceInfo,
  type SettleResponse,
  type VerifyResponse,
} from "./protocol";

/**
 * x402 seller paywall: charge per request in USDC, verified and settled by an
 * x402 facilitator (Agent Bank runs one at `/v1/x402`).
 *
 * Framework-agnostic core ({@link Paywall.process}) plus adapters for
 * Express/Connect, Node `http`, Fastify, and Web `Request`/`Response`
 * runtimes (Hono, Next.js route handlers, Bun, Deno, Workers).
 *
 * Settlement timing (design doc, "Security"): payments **above $1.00 are
 * settled before the handler runs** (settle-before-serve), so a payer cannot
 * exploit the gap between verification and settlement for valuable
 * resources. Cheaper requests run the handler first and settle afterwards;
 * the response is held back until settlement succeeds (a failed settlement
 * turns it into a 402) and handler errors (status ≥ 400) are never charged.
 * Every authorization is single-use: concurrent replays of the same payment
 * are refused before reaching the facilitator.
 *
 * @packageDocumentation
 */

/** USDC decimals. */
const USDC_DECIMALS = 6;
/** Prices strictly above this many atomic units ($1.00) settle before serving. */
export const SETTLE_BEFORE_SERVE_ABOVE = 1_000_000n;

/** Options of {@link createPaywall}. */
export interface PaywallOptions {
  /**
   * Facilitator base URL; the paywall POSTs to `${facilitatorUrl}/verify`
   * and `${facilitatorUrl}/settle`. Agent Bank: `https://<api>/v1/x402`.
   */
  facilitatorUrl: string;
  /** Address that receives the payments (your account address). */
  payTo: string;
  /** Price per request in USDC, e.g. `"0.01"` or `"$0.01"`. */
  price: string;
  /** CAIP-2 network (default `eip155:84532`, Base Sepolia). Mainnets are refused. */
  network?: string;
  /** Token address (default: USDC on the network). */
  asset?: string;
  /** Human-readable description of the resource. */
  description?: string;
  /** MIME type of the resource. */
  mimeType?: string;
  /** Seconds the payer's authorization must stay valid (default 60). */
  maxTimeoutSeconds?: number;
  /** Fixed resource URL to advertise (default: the request URL). */
  resource?: string;
  /**
   * `"auto"` (default): settle before serving when the price is above $1.00,
   * after the handler otherwise. `"before-serve"`: always settle first.
   */
  settlement?: "auto" | "before-serve";
  /**
   * Extra headers for facilitator calls, or a function returning them.
   * Agent Bank's facilitator routes are public; third-party facilitators may
   * need an `Authorization` header here.
   */
  facilitatorHeaders?:
    Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** `fetch` used to call the facilitator (default: global `fetch`). */
  fetch?: FetchLike;
  /** Timeout of each facilitator call in milliseconds (default 30000). */
  facilitatorTimeoutMs?: number;
  /** Also accept x402 v1 payments (`X-PAYMENT`) and advertise a v1 challenge body (default `true`). */
  acceptV1?: boolean;
}

/** A framework-neutral view of the incoming request. */
export interface PaywallRequest {
  /** Absolute URL of the request. */
  url: string;
  method: string;
  headers: Headers | Record<string, string | string[] | undefined>;
}

/** A response for the adapter to send. */
export interface PaywallResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Outcome of a settlement attempt. */
export type SettlementOutcome =
  | {
      success: true;
      settlement: SettleResponse;
      /** Headers to add to the resource response (`PAYMENT-RESPONSE`). */
      headers: Record<string, string>;
    }
  | {
      success: false;
      settlement: SettleResponse | undefined;
      /** The error response to send instead of the resource. */
      response: PaywallResponse;
    };

/** Result of {@link Paywall.process}. */
export type PaywallDecision =
  | { kind: "payment-required"; response: PaywallResponse }
  | {
      kind: "verified";
      /** Settle before running the handler (price above $1.00 or `settlement: "before-serve"`). */
      settleBeforeServe: boolean;
      /** Payer address reported by the facilitator. */
      payer: string | undefined;
      /** Price as a decimal USDC string. */
      amount: string;
      /** Settle the payment (idempotent: later calls return the first outcome). */
      settle(): Promise<SettlementOutcome>;
    };

/** A configured paywall. */
export interface Paywall {
  /** The v2 payment requirements this paywall advertises. */
  readonly requirements: PaymentRequirements;
  /** Price as a decimal USDC string. */
  readonly price: string;
  /** Whether payments settle before the handler runs. */
  readonly settleBeforeServe: boolean;
  /** Check the request's payment: either a 402 to send or a verified payment to settle. */
  process(request: PaywallRequest): Promise<PaywallDecision>;
}

/** Thrown when the facilitator cannot be reached or answers with an error. */
export class FacilitatorError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FacilitatorError";
  }
}

function headerValue(headers: PaywallRequest["headers"], name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== lower || value === undefined) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * In-flight and used authorizations (payer + nonce), kept until they expire
 * (at most one hour). Payloads that fail verification are released, so only
 * genuine payments occupy memory.
 */
class ReplayGuard {
  readonly #seen = new Map<string, number>();
  #nextSweep = 0;

  claim(key: string, validBefore: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    if (now >= this.#nextSweep) {
      for (const [k, exp] of this.#seen) if (exp < now) this.#seen.delete(k);
      this.#nextSweep = now + 10;
    }
    const existing = this.#seen.get(key);
    if (existing !== undefined && existing >= now) return false;
    this.#seen.set(key, Math.min(Number.isFinite(validBefore) ? validBefore : now, now + 3600));
    return true;
  }

  release(key: string): void {
    this.#seen.delete(key);
  }
}

class FacilitatorClient {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchLike,
    private readonly headers: PaywallOptions["facilitatorHeaders"],
    private readonly timeoutMs: number,
  ) {}

  async #post(path: "verify" | "settle", body: unknown): Promise<Record<string, unknown>> {
    const extra = typeof this.headers === "function" ? await this.headers() : (this.headers ?? {});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.url.replace(/\/+$/, "")}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...extra },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      throw new FacilitatorError(
        `Facilitator ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new FacilitatorError(
        `Facilitator ${path} returned non-JSON (HTTP ${response.status})`,
        response.status,
      );
    }
    if (!json || typeof json !== "object") {
      throw new FacilitatorError(`Facilitator ${path} returned an invalid body`, response.status);
    }
    return json as Record<string, unknown>;
  }

  async verify(body: unknown): Promise<VerifyResponse> {
    const json = await this.#post("verify", body);
    if (typeof json.isValid !== "boolean")
      throw new FacilitatorError("Facilitator verify returned no isValid");
    return json as VerifyResponse;
  }

  async settle(body: unknown): Promise<SettleResponse> {
    const json = await this.#post("settle", body);
    const parsed = SettleResponseSchema.safeParse(json);
    if (!parsed.success) throw new FacilitatorError("Facilitator settle returned an invalid response");
    return parsed.data as SettleResponse;
  }
}

/**
 * Create a paywall. See the module docs for settlement timing.
 *
 * @example Express
 * ```ts
 * const paywall = createPaywall({
 *   facilitatorUrl: "http://localhost:8080/v1/x402",
 *   payTo: "0xYourAccountAddress",
 *   price: "0.01",
 *   description: "Weather report",
 * });
 * app.get("/weather", expressPaywall(paywall), (req, res) => res.json({ temp: 21 }));
 * ```
 */
export function createPaywall(options: PaywallOptions): Paywall {
  const network = options.network ?? "eip155:84532";
  const chainId = chainIdOfNetwork(network);
  if (chainId === undefined || !network.startsWith("eip155:")) {
    throw new InvalidRequestError(
      "invalid_request",
      `network must be CAIP-2 eip155:<chainId>, got "${network}"`,
    );
  }
  assertTestnet(chainId);
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.payTo)) {
    throw new InvalidRequestError("invalid_request", "payTo must be a 0x-prefixed address");
  }
  const usdc = getAsset(chainId, "USDC");
  const asset = options.asset ?? usdc.address;
  const priceMinor = parseAmount(options.price.trim().replace(/^\$/, ""), USDC_DECIMALS);
  if (priceMinor <= 0n) throw new InvalidRequestError("invalid_amount", "price must be greater than zero");
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 60;
  const acceptV1 = options.acceptV1 ?? true;
  const v1Network = v1NetworkOf(chainId);
  const facilitator = new FacilitatorClient(
    options.facilitatorUrl,
    options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    options.facilitatorHeaders,
    options.facilitatorTimeoutMs ?? 30_000,
  );
  const replay = new ReplayGuard();
  const settleBeforeServe = options.settlement === "before-serve" || priceMinor > SETTLE_BEFORE_SERVE_ABOVE;
  const price = formatAmount(priceMinor, USDC_DECIMALS);

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network,
    asset,
    amount: priceMinor.toString(),
    payTo: options.payTo,
    maxTimeoutSeconds,
    extra: sameAddress(asset, usdc.address) ? { name: usdc.eip712.name, version: usdc.eip712.version } : {},
  };

  const resourceFor = (url: string): ResourceInfo => ({
    url: options.resource ?? url,
    ...(options.description ? { description: options.description } : {}),
    ...(options.mimeType ? { mimeType: options.mimeType } : {}),
  });

  const paymentRequired = (
    url: string,
    error: string,
    extraHeaders: Record<string, string> = {},
  ): PaywallResponse => {
    const resource = resourceFor(url);
    const challenge: PaymentRequired = { x402Version: 2, error, resource, accepts: [requirements] };
    const v1Requirements: PaymentRequirementsV1 | undefined = v1Network
      ? {
          scheme: "exact",
          network: v1Network,
          maxAmountRequired: requirements.amount,
          resource: resource.url,
          description: options.description ?? "",
          mimeType: options.mimeType ?? "",
          payTo: requirements.payTo,
          maxTimeoutSeconds,
          asset,
          extra: requirements.extra,
        }
      : undefined;
    const body: PaymentRequiredV1 | Record<string, never> =
      acceptV1 && v1Requirements ? { x402Version: 1, error, accepts: [v1Requirements] } : {};
    return {
      status: 402,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        [X402_HEADERS.paymentRequired]: encodeHeaderValue(challenge),
        "Access-Control-Expose-Headers": `${X402_HEADERS.paymentRequired}, ${X402_HEADERS.paymentResponse}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    };
  };

  // Fail closed without leaking facilitator internals to the buyer.
  const unavailable = (): PaywallResponse => ({
    status: 502,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({
      error: "facilitator_unavailable",
      detail: "The payment facilitator is unavailable; try again later",
    }),
  });

  const matches = (accepted: PaymentRequirements): boolean =>
    accepted.scheme === requirements.scheme &&
    accepted.network === requirements.network &&
    sameAddress(accepted.asset, requirements.asset) &&
    accepted.amount === requirements.amount &&
    sameAddress(accepted.payTo, requirements.payTo) &&
    accepted.maxTimeoutSeconds === requirements.maxTimeoutSeconds &&
    Object.entries(requirements.extra).every(([k, v]) => accepted.extra?.[k] === v);

  const decode = (
    request: PaywallRequest,
  ): { payload: PaymentPayload; version: 1 | 2 } | string | undefined => {
    const v2 = headerValue(request.headers, X402_HEADERS.paymentSignature);
    const v1 = acceptV1 ? headerValue(request.headers, X402_HEADERS.v1Payment) : undefined;
    if (!v2 && !v1) return undefined;
    let decoded: unknown;
    try {
      decoded = decodeHeaderValue((v2 ?? v1) as string);
    } catch {
      return "invalid_payment_header";
    }
    if (v2) {
      const parsed = PaymentPayloadSchema.safeParse(decoded);
      if (!parsed.success) return "invalid_payment_payload";
      const payload = parsed.data as unknown as PaymentPayload;
      return matches(payload.accepted) ? { payload, version: 2 } : "no_matching_requirements";
    }
    const parsed = PaymentPayloadV1Schema.safeParse(decoded);
    if (!parsed.success) return "invalid_payment_payload";
    if (parsed.data.scheme !== "exact" || parsed.data.network !== v1Network)
      return "no_matching_requirements";
    // v1 and v2 `exact` payloads carry the same EIP-3009 authorization; verify it as v2.
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: resourceFor(request.url),
      accepted: requirements,
      payload: parsed.data.payload,
    };
    return { payload, version: 1 };
  };

  return {
    requirements,
    price,
    settleBeforeServe,
    async process(request: PaywallRequest): Promise<PaywallDecision> {
      const decoded = decode(request);
      if (decoded === undefined) {
        return { kind: "payment-required", response: paymentRequired(request.url, "Payment required") };
      }
      if (typeof decoded === "string") {
        return { kind: "payment-required", response: paymentRequired(request.url, decoded) };
      }
      const { payload, version } = decoded;
      const auth = payload.payload.authorization;
      const replayKey = `${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
      if (!replay.claim(replayKey, Number(auth.validBefore))) {
        return {
          kind: "payment-required",
          response: paymentRequired(request.url, "authorization_already_used"),
        };
      }
      const facilitatorBody = { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements };
      let verification: VerifyResponse;
      try {
        verification = await facilitator.verify(facilitatorBody);
      } catch {
        replay.release(replayKey);
        return { kind: "payment-required", response: unavailable() };
      }
      if (!verification.isValid) {
        replay.release(replayKey);
        return {
          kind: "payment-required",
          response: paymentRequired(request.url, verification.invalidReason ?? "invalid_payment"),
        };
      }
      const responseHeader = version === 1 ? X402_HEADERS.v1PaymentResponse : X402_HEADERS.paymentResponse;
      let outcome: Promise<SettlementOutcome> | undefined;
      const settleOnce = async (): Promise<SettlementOutcome> => {
        let settlement: SettleResponse;
        try {
          settlement = await facilitator.settle(facilitatorBody);
        } catch {
          return { success: false, settlement: undefined, response: unavailable() };
        }
        const encoded = encodeHeaderValue(settlement);
        if (!settlement.success) {
          return {
            success: false,
            settlement,
            response: paymentRequired(request.url, settlement.errorReason ?? "settlement_failed", {
              [responseHeader]: encoded,
            }),
          };
        }
        return {
          success: true,
          settlement,
          headers: {
            [responseHeader]: encoded,
            "Access-Control-Expose-Headers": `${X402_HEADERS.paymentRequired}, ${X402_HEADERS.paymentResponse}`,
          },
        };
      };
      return {
        kind: "verified",
        settleBeforeServe,
        payer: verification.payer ?? auth.from,
        amount: price,
        settle: () => (outcome ??= settleOnce()),
      };
    },
  };
}
