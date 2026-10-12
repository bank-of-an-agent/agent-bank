import { z } from "zod";
import {
  AddressSchema,
  AssetCodeSchema,
  DecimalString,
  DomainSchema,
  Erc8004IdSchema,
  idSchema,
  TimestampSchema,
} from "./schemas";

/**
 * Policy documents: the owner-defined spending rules for one agent.
 * The deterministic evaluator lives in `@agentbank/policy`; the schema lives
 * here because the API contract, the co-signer and the SDKs all share it.
 */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const PAYMENT_KINDS = ["transfer", "x402", "escrow", "stream", "payout", "refill"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

const CounterpartyList = z
  .object({
    addresses: z.array(AddressSchema).max(1000).optional(),
    agent_ids: z.array(idSchema("agent")).max(1000).optional(),
    erc8004_ids: z.array(Erc8004IdSchema).max(1000).optional(),
    x402_domains: z.array(DomainSchema).max(1000).optional(),
  })
  .strict();

export const CounterpartyMatchSchema = z
  .object({
    address: AddressSchema.optional(),
    agent_id: idSchema("agent").optional(),
    erc8004_id: Erc8004IdSchema.optional(),
    x402_domain: DomainSchema.optional(),
  })
  .strict()
  .refine((m) => Object.values(m).filter((v) => v !== undefined).length === 1, {
    message: "match exactly one of address, agent_id, erc8004_id, x402_domain",
  });

export const CounterpartyCapSchema = z
  .object({
    match: CounterpartyMatchSchema,
    per_tx: DecimalString.optional(),
    per_day: DecimalString.optional(),
    per_month: DecimalString.optional(),
  })
  .strict();

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Allowed payment window. `start` is inclusive and `end` exclusive, in the
 * window's IANA time zone; `end` may be "24:00". A window whose start is after
 * its end runs overnight (e.g. 22:00–06:00). Start equal to end is invalid.
 */
export const TimeWindowSchema = z
  .object({
    days: z.array(z.enum(WEEKDAYS)).min(1),
    start: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "HH:MM"),
    end: z.string().regex(/^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/, "HH:MM or 24:00"),
    timezone: z.string().min(1).refine(isTimeZone, "must be an IANA time zone").default("UTC"),
  })
  .strict()
  .refine((w) => w.start !== w.end, { message: "start and end must differ" });

export const ApprovalThresholdSchema = z
  .object({ above: DecimalString, approvers: z.number().int().min(1).max(5) })
  .strict();

export const VaultTarget = z
  .string()
  .regex(/^(treasury|vault:vlt_[0-9A-HJKMNP-TV-Z]{26})$/, 'must be "treasury" or "vault:<vault id>"');

export const AutoSaveSchema = z
  .object({
    income_split: z
      .object({ bps: z.number().int().min(1).max(10_000), to: VaultTarget })
      .strict()
      .optional(),
    excess_sweep: z.object({ to: VaultTarget }).strict().optional(),
    round_up: z
      .object({
        to_nearest: DecimalString.refine((v) => /[1-9]/.test(v), "must be greater than zero"),
        to: VaultTarget,
      })
      .strict()
      .optional(),
    scheduled: z
      .array(
        z
          .object({ amount: DecimalString, every: z.enum(["day", "week", "month"]), to: VaultTarget })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();

export const PolicyDocumentSchema = z
  .object({
    $schema: z.literal("agentbank.policy.v1").optional(),
    agent: z.string().optional().meta({ description: "Agent id; must match the path when present" }),
    asset: AssetCodeSchema.default("USDC"),
    limits: z
      .object({
        per_tx: DecimalString.optional(),
        per_day: DecimalString.optional(),
        per_week: DecimalString.optional(),
        per_month: DecimalString.optional(),
      })
      .strict()
      .default({}),
    counterparties: z
      .object({
        mode: z.enum(["open", "allowlist", "denylist"]).default("open"),
        ...CounterpartyList.shape,
        deny: CounterpartyList.optional(),
        new_cooldown_minutes: z.number().int().min(0).max(10_080).optional(),
        caps: z.array(CounterpartyCapSchema).max(100).optional(),
      })
      .strict()
      .refine(
        (c) =>
          c.mode !== "open" ||
          [c.addresses, c.agent_ids, c.erc8004_ids, c.x402_domains].every(
            (list) => !list || list.length === 0,
          ),
        { message: 'top-level counterparty lists have no effect in "open" mode; use "deny" or another mode' },
      )
      .default({ mode: "open" }),
    velocity: z
      .object({
        max_per_minute: z.number().int().min(1).optional(),
        max_per_hour: z.number().int().min(1).optional(),
        max_per_day: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    time_windows: z.array(TimeWindowSchema).min(1).max(20).optional(),
    max_balance: DecimalString.optional(),
    approvals: z.array(ApprovalThresholdSchema).max(5).optional(),
    require_owner_above: DecimalString.optional(),
    allowed_kinds: z.array(z.enum(PAYMENT_KINDS)).min(1).optional(),
    auto_save: AutoSaveSchema.optional(),
  })
  .strict()
  .meta({
    id: "PolicyDocument",
    description:
      "Owner-defined spending rules for one agent. Tightening applies immediately; loosening requires an owner signature and a 1-hour delay.",
  });

export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;
export type PolicyDocumentInput = z.input<typeof PolicyDocumentSchema>;

export const DECISION_OUTCOMES = ["allow", "deny", "require_approval", "require_owner"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const RuleHitSchema = z
  .object({
    rule: z.string().meta({ description: 'Rule identifier, e.g. "limits.per_day"' }),
    effect: z.enum(["allow", "deny", "require_approval", "require_owner", "info"]),
    detail: z.string(),
  })
  .meta({ id: "RuleHit" });

export type RuleHit = z.infer<typeof RuleHitSchema>;

export const PolicyDecisionSchema = z
  .object({
    id: z.string().optional(),
    outcome: z.enum(DECISION_OUTCOMES),
    rule_hits: z.array(RuleHitSchema),
    approvers_required: z.number().int().min(0),
    policy_version: z.number().int().min(0),
    evaluated_at: TimestampSchema,
    retry_at: TimestampSchema.nullable()
      .optional()
      .meta({ description: "When a time-based denial (cooling period, time window) lifts" }),
  })
  .meta({ id: "PolicyDecision", description: "Deterministic decision of the policy engine." });

export type PolicyDecisionWire = z.infer<typeof PolicyDecisionSchema>;

/** Session key scope; compiled into the on-chain Smart Sessions policies. */
export const SessionScopeSchema = z
  .object({
    asset: AssetCodeSchema.default("USDC"),
    max_per_tx: DecimalString,
    max_per_day: DecimalString,
    allowed_recipients: z.array(AddressSchema).max(100).optional(),
    allowed_contracts: z.array(AddressSchema).max(20).optional(),
    expires_at: TimestampSchema,
  })
  .strict()
  .meta({ id: "SessionScope", description: "On-chain enforced scope of a session key." });

export type SessionScope = z.infer<typeof SessionScopeSchema>;

/** Default session lifetime from the design: 24 hours. Maximum: 7 days. */
export const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
export const MAX_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Loosening delay from the design: 1 hour. */
export const LOOSENING_DELAY_SECONDS = 60 * 60;
/** Approvals expire after 15 minutes. */
export const APPROVAL_TTL_SECONDS = 15 * 60;
