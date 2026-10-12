import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { bytesToHex, hexToBytes, timingSafeEqual, utf8 } from "./encoding";
import { AgentBankError } from "./errors";
import { OpenPaymentMandateSchema } from "./mandate-schema";
import {
  PAYMENT_KINDS,
  PolicyDecisionSchema,
  PolicyDocumentSchema,
  SessionScopeSchema,
} from "./policy-schema";
import {
  AddressSchema,
  Bytes32Schema,
  DomainSchema,
  HexSchema,
  OwnerAuthorizationSchema,
  TimestampSchema,
} from "./schemas";

/**
 * Internal API between `apps/api` and `apps/cosigner` (separate cloud
 * account). Both sides import these schemas, so they cannot drift.
 *
 * The co-signer never trusts the API's description of an operation: it
 * decodes the raw user operation itself, verifies the session signature,
 * re-evaluates its own copy of the policy against its own spend history and
 * only then signs. Amounts on this API are integer minor units as strings.
 */

export const MinorUnitsString = z.string().regex(/^(0|[1-9][0-9]{0,18})$/, "integer minor units");

const CounterpartyRef = z.object({
  address: AddressSchema.optional(),
  contract: AddressSchema.optional(),
  agent_id: z.string().optional(),
  erc8004_id: z.string().optional(),
  x402_domain: DomainSchema.optional(),
});

export const CosignerRoutes = {
  registerSession: { method: "POST", path: "/internal/v1/sessions" },
  revokeSession: { method: "DELETE", path: "/internal/v1/sessions/:id" },
  putPolicy: { method: "POST", path: "/internal/v1/policies" },
  getPolicy: { method: "GET", path: "/internal/v1/policies/:agentId" },
  registerMandate: { method: "POST", path: "/internal/v1/mandates" },
  setTreasury: { method: "POST", path: "/internal/v1/treasury" },
  rotateOwner: { method: "POST", path: "/internal/v1/owner" },
  revokeMandate: { method: "DELETE", path: "/internal/v1/mandates/:id" },
  freeze: { method: "POST", path: "/internal/v1/freeze" },
  unfreeze: { method: "POST", path: "/internal/v1/unfreeze" },
  evaluate: { method: "POST", path: "/internal/v1/evaluate" },
  cosign: { method: "POST", path: "/internal/v1/cosign" },
  authorizeX402: { method: "POST", path: "/internal/v1/x402/authorize" },
  reportSettlement: { method: "POST", path: "/internal/v1/settlements" },
  audit: { method: "GET", path: "/internal/v1/audit" },
  health: { method: "GET", path: "/healthz" },
} as const;

export const RegisterSessionInternal = z.object({
  session_id: z.string(),
  org_id: z.string(),
  agent_id: z.string(),
  account_id: z.string(),
  chain_id: z.number().int(),
  account_address: AddressSchema,
  owner_address: AddressSchema,
  public_key: AddressSchema,
  scope: SessionScopeSchema,
  owner_authorization: OwnerAuthorizationSchema,
});

export const PutPolicyInternal = z.object({
  org_id: z.string(),
  agent_id: z.string(),
  chain_id: z.number().int(),
  owner_address: AddressSchema,
  policy: PolicyDocumentSchema,
  owner_authorization: OwnerAuthorizationSchema.optional(),
});

export const PolicyVersionInternal = z.object({
  agent_id: z.string(),
  version: z.number().int().positive(),
  policy: PolicyDocumentSchema,
  policy_hash: Bytes32Schema,
  change_kind: z.enum(["initial", "tighten", "loosen", "mixed", "unchanged"]),
  effective_at: TimestampSchema,
  signed_by: AddressSchema.nullable(),
});

export const PolicyStateInternal = z.object({
  current: PolicyVersionInternal.nullable(),
  pending: PolicyVersionInternal.nullable(),
});

export const RegisterMandateInternal = z.object({
  mandate_id: z.string(),
  org_id: z.string(),
  agent_id: z.string(),
  chain_id: z.number().int(),
  owner_address: AddressSchema,
  mandate: OpenPaymentMandateSchema,
  owner_authorization: OwnerAuthorizationSchema,
});

/** Register the org treasury (owner-authorized `treasury.set`), so savings sweeps to it can be co-signed. */
export const SetTreasuryInternal = z.object({
  org_id: z.string(),
  chain_id: z.number().int(),
  owner_address: AddressSchema,
  account_id: z.string(),
  treasury_address: AddressSchema,
  owner_authorization: OwnerAuthorizationSchema,
});

/** Voluntary owner rotation authorized by the current owner (`owner.rotate`). */
export const RotateOwnerInternal = z.object({
  org_id: z.string(),
  chain_id: z.number().int(),
  owner_address: AddressSchema.meta({ description: "Current owner" }),
  new_owner_address: AddressSchema,
  owner_authorization: OwnerAuthorizationSchema,
});

export const FreezeInternal = z.object({
  scope: z.enum(["org", "agent", "session"]),
  id: z.string(),
  reason: z.string().min(1).max(500),
});

export const UnfreezeInternal = FreezeInternal.extend({
  chain_id: z.number().int(),
  owner_address: AddressSchema,
  owner_authorization: OwnerAuthorizationSchema,
});

export const IntentInternal = z.object({
  kind: z.enum(PAYMENT_KINDS),
  amount: MinorUnitsString,
  asset: z.literal("USDC"),
  counterparty: CounterpartyRef,
});

export const EvaluateInternal = z.object({
  org_id: z.string(),
  agent_id: z.string(),
  account_id: z.string(),
  account_address: AddressSchema,
  chain_id: z.number().int(),
  intent: IntentInternal,
  mandate_id: z.string().optional(),
  session_id: z.string().optional(),
});

export const DecisionInternal = PolicyDecisionSchema.extend({ id: z.string() });

/**
 * What the operation does, so the co-signer can match calls to intent:
 * - `transfer` (kinds transfer/payout/refill): exactly one USDC transfer.
 * - `escrow.lock` / `stream.create`: approve immediately followed by lock/create for the same amount.
 * - `stream.top_up`: approve immediately followed by `topUp(id, amount)`; `amount` = the top-up.
 * - `escrow.release` / `escrow.refund` / `escrow.dispute` / `stream.cancel`: exactly one call to the
 *   configured escrow/streams contract and **no outflow** (`intent.amount` = "0"); the contract
 *   enforces who may call and where funds go.
 * Any action may additionally carry up to two USDC transfers to the revenue address (fees and
 * fee sweeps) and one to the org treasury (savings sweep, see `setTreasury`).
 */
export const COSIGN_ACTIONS = [
  "transfer",
  "escrow.lock",
  "escrow.release",
  "escrow.refund",
  "escrow.dispute",
  "stream.create",
  "stream.cancel",
  "stream.top_up",
] as const;

export const CosignInternal = z.object({
  /** Defaults to `transfer` for kinds transfer/payout/refill, `escrow.lock` for escrow, `stream.create` for stream. */
  action: z.enum(COSIGN_ACTIONS).optional(),
  /** Escrow or stream id on-chain for post-lock actions. */
  onchain_id: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  /** Savings sweep to the org treasury included in this operation (minor units). */
  savings_sweep: MinorUnitsString.optional(),
  payment_id: z.string(),
  org_id: z.string(),
  agent_id: z.string(),
  account_id: z.string(),
  account_address: AddressSchema,
  chain_id: z.number().int(),
  session_id: z.string(),
  /** The prepared operation exactly as `ChainGateway.prepareOperation` returned it (JSON-safe). */
  operation: z.record(z.string(), z.unknown()),
  user_op_hash: Bytes32Schema,
  session_signature: HexSchema,
  intent: IntentInternal,
  fee: MinorUnitsString,
  mandate_id: z.string().optional(),
  approval: z
    .object({ approval_id: z.string(), approved_by: z.array(z.string()).min(1) })
    .optional()
    .meta({ description: "API-attested human approval (ADR 0012)" }),
});

export const CosignResultInternal = z.object({
  decision: DecisionInternal,
  signature: HexSchema.nullable(),
  cosigner_address: AddressSchema,
});

export const AuthorizeX402Internal = z.object({
  payment_id: z.string(),
  org_id: z.string(),
  agent_id: z.string(),
  account_id: z.string(),
  account_address: AddressSchema,
  chain_id: z.number().int(),
  spend_key_address: AddressSchema,
  x402_domain: DomainSchema,
  pay_to: AddressSchema,
  amount: MinorUnitsString,
  asset: z.literal("USDC"),
  mandate_id: z.string().optional(),
});

export const AuthorizeX402ResultInternal = z.object({ decision: DecisionInternal });

export const SettlementReportInternal = z.object({
  payment_id: z.string(),
  status: z.enum(["settled", "failed"]),
  amount: MinorUnitsString.optional(),
});

export const AuditRecordInternal = z.object({
  seq: z.number().int().positive(),
  at: z.string(),
  actor: z.string(),
  action: z.string(),
  subject: z.string(),
  payload: z.unknown(),
  prevHash: z.string(),
  hash: z.string(),
});

export const AuditPageInternal = z.object({ records: z.array(AuditRecordInternal) });

export const CosignerHealth = z.object({
  status: z.enum(["ok", "degraded"]),
  cosigner_address: AddressSchema,
  signer: z.enum(["local", "kms"]),
  fail_closed: z.boolean(),
  checks: z.record(z.string(), z.string()),
});

export const OkResponse = z.object({ ok: z.literal(true) });
export const EffectiveAtResponse = z.object({ effective_at: TimestampSchema });

export type RegisterSessionInternal = z.infer<typeof RegisterSessionInternal>;
export type PutPolicyInternal = z.infer<typeof PutPolicyInternal>;
export type PolicyVersionInternal = z.infer<typeof PolicyVersionInternal>;
export type PolicyStateInternal = z.infer<typeof PolicyStateInternal>;
export type RegisterMandateInternal = z.infer<typeof RegisterMandateInternal>;
export type FreezeInternal = z.infer<typeof FreezeInternal>;
export type SetTreasuryInternal = z.infer<typeof SetTreasuryInternal>;
export type RotateOwnerInternal = z.infer<typeof RotateOwnerInternal>;
export type UnfreezeInternal = z.infer<typeof UnfreezeInternal>;
export type IntentInternal = z.infer<typeof IntentInternal>;
export type EvaluateInternal = z.infer<typeof EvaluateInternal>;
export type DecisionInternal = z.infer<typeof DecisionInternal>;
export type CosignInternal = z.infer<typeof CosignInternal>;
export type CosignResultInternal = z.infer<typeof CosignResultInternal>;
export type AuthorizeX402Internal = z.infer<typeof AuthorizeX402Internal>;
export type SettlementReportInternal = z.infer<typeof SettlementReportInternal>;
export type CosignerHealth = z.infer<typeof CosignerHealth>;

/**
 * The co-signer as seen by its callers. `HttpCosignerClient` (apps/api)
 * implements it over HTTP; tests may implement it in-process.
 */
export interface CosignerClient {
  registerSession(input: RegisterSessionInternal): Promise<void>;
  revokeSession(sessionId: string): Promise<void>;
  putPolicy(input: PutPolicyInternal): Promise<PolicyVersionInternal>;
  getPolicy(agentId: string): Promise<PolicyStateInternal>;
  registerMandate(input: RegisterMandateInternal): Promise<void>;
  setTreasury(input: SetTreasuryInternal): Promise<void>;
  rotateOwner(input: RotateOwnerInternal): Promise<void>;
  revokeMandate(mandateId: string): Promise<void>;
  freeze(input: FreezeInternal): Promise<void>;
  unfreeze(input: UnfreezeInternal): Promise<{ effective_at: string }>;
  evaluate(input: EvaluateInternal): Promise<DecisionInternal>;
  cosign(input: CosignInternal): Promise<CosignResultInternal>;
  authorizeX402(input: AuthorizeX402Internal): Promise<{ decision: DecisionInternal }>;
  reportSettlement(input: SettlementReportInternal): Promise<void>;
  health(): Promise<CosignerHealth>;
}

// ------------------------------------------------------------------ internal request auth

export const INTERNAL_AUTH_SCHEME = "AgentBank-Internal";
export const INTERNAL_AUTH_TOLERANCE_SECONDS = 60;

function internalMac(secret: string, t: number, method: string, path: string, body: string): Uint8Array {
  return hmac(sha256, utf8(secret), utf8(`${t}.${method.toUpperCase()} ${path}\n${body}`));
}

/** `Authorization` header value for an internal request (binds time, method, path and body). */
export function signInternalRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
  t: number = Math.floor(Date.now() / 1000),
): string {
  return `${INTERNAL_AUTH_SCHEME} t=${t},v1=${bytesToHex(internalMac(secret, t, method, path, body)).slice(2)}`;
}

/** Verify an internal request's `Authorization` header. Throws `unauthorized`. */
export function verifyInternalRequest(
  secret: string,
  header: string | undefined,
  method: string,
  path: string,
  body: string,
  now: number = Math.floor(Date.now() / 1000),
): void {
  if (!header?.startsWith(`${INTERNAL_AUTH_SCHEME} `)) {
    throw new AgentBankError("unauthorized", "Missing internal authorization");
  }
  const params = new Map(
    header
      .slice(INTERNAL_AUTH_SCHEME.length + 1)
      .split(",")
      .map((p) => {
        const i = p.indexOf("=");
        return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
      }),
  );
  const t = Number(params.get("t"));
  const v1 = params.get("v1") ?? "";
  if (!Number.isInteger(t) || Math.abs(now - t) > INTERNAL_AUTH_TOLERANCE_SECONDS) {
    throw new AgentBankError("unauthorized", "Internal authorization expired");
  }
  let given: Uint8Array;
  try {
    given = hexToBytes(v1);
  } catch {
    throw new AgentBankError("unauthorized", "Malformed internal authorization");
  }
  if (!timingSafeEqual(given, internalMac(secret, t, method, path, body))) {
    throw new AgentBankError("unauthorized", "Internal authorization invalid");
  }
}
