/**
 * `@agentbank/sdk/x402-server`: charge per request with x402.
 *
 * {@link createPaywall} builds a framework-agnostic paywall that verifies
 * payments with an x402 facilitator and settles them, **before** serving
 * when the price is above $1.00 and after the handler otherwise. Adapters:
 * {@link expressPaywall} (Express/Connect), {@link nodePaywall} (`node:http`),
 * {@link fastifyPaywall} (route hooks), {@link honoPaywall} (Hono) and
 * {@link withPaywall} (Web `Request`/`Response`: Next.js, Bun, Deno, Workers).
 *
 * @packageDocumentation
 */

export {
  createPaywall,
  FacilitatorError,
  SETTLE_BEFORE_SERVE_ABOVE,
  type Paywall,
  type PaywallDecision,
  type PaywallOptions,
  type PaywallRequest,
  type PaywallResponse,
  type SettlementOutcome,
} from "./x402/paywall";

export {
  expressPaywall,
  fastifyPaywall,
  honoPaywall,
  nodePaywall,
  withPaywall,
  type FastifyReplyLike,
  type FastifyRequestLike,
  type HonoContextLike,
} from "./x402/adapters";

export {
  decodeHeaderValue,
  encodeHeaderValue,
  X402_HEADERS,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from "./x402/protocol";
