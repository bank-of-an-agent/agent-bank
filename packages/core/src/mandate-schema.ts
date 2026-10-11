import { z } from "zod";
import { AddressSchema, DomainSchema } from "./schemas";

/**
 * Mandates follow the AP2 v0.2 *open Payment Mandate* (`vct:
 * mandate.payment.open.1`) shape: a set of typed constraints, a `cnf` key
 * binding, `iat` and `exp`. Agent Bank adds two extension claims
 * (`agent_id`, `description`) and one extension constraint
 * (`agentbank.x402_domains`).
 *
 * AP2 secures mandates as SD-JWTs; principals in Agent Bank hold Ethereum
 * owner keys, so v1 signs the canonical JSON with an EIP-712
 * `OwnerAuthorization` (action `mandate.issue`). An SD-JWT envelope is a
 * planned addition (see docs/adr/0006-ap2-mandates.md).
 *
 * AP2 amounts are integers in minor units of `currency`: cents for "USD",
 * micro-units (6 decimals) for "USDC". USD and USDC are treated 1:1.
 */

const MinorUnits = z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
]);

export const MandateCurrencySchema = z.enum(["USD", "USDC"]);

const AmountRange = z
  .object({
    type: z.literal("payment.amount_range"),
    currency: MandateCurrencySchema,
    max: MinorUnits,
    min: MinorUnits.optional(),
  })
  .strict();

const Payee = z
  .object({
    id: z
      .string()
      .min(1)
      .meta({ description: "Address, Agent Bank agent id (agt_…), ERC-8004 id or x402 domain" }),
    name: z.string().min(1),
    website: z.string().optional(),
  })
  .strict();

const AllowedPayees = z
  .object({ type: z.literal("payment.allowed_payees"), allowed: z.array(Payee).min(1).max(1000) })
  .strict();

const Budget = z
  .object({ type: z.literal("payment.budget"), currency: MandateCurrencySchema, max: MinorUnits })
  .strict();

const Recurrence = z
  .object({
    type: z.literal("payment.agent_recurrence"),
    frequency: z.enum(["ON_DEMAND", "DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "ANNUALLY"]),
    max_occurrences: z.number().int().positive().optional(),
  })
  .strict();

const ExecutionDate = z
  .object({
    type: z.literal("payment.execution_date"),
    not_before: z.iso.datetime({ offset: true }).optional(),
    not_after: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

const X402Domains = z
  .object({ type: z.literal("agentbank.x402_domains"), allowed: z.array(DomainSchema).min(1).max(1000) })
  .strict();

export const MandateConstraintSchema = z.discriminatedUnion("type", [
  AmountRange,
  AllowedPayees,
  Budget,
  Recurrence,
  ExecutionDate,
  X402Domains,
]);

export type MandateConstraint = z.infer<typeof MandateConstraintSchema>;

const Secp256k1Jwk = z
  .object({ kty: z.literal("EC"), crv: z.literal("secp256k1"), x: z.string().min(1), y: z.string().min(1) })
  .strict();

export const OpenPaymentMandateSchema = z
  .object({
    vct: z.literal("mandate.payment.open.1"),
    constraints: z.array(MandateConstraintSchema).min(1).max(50),
    cnf: z
      .union([z.object({ jwk: Secp256k1Jwk }).strict(), z.object({ eth_address: AddressSchema }).strict()])
      .optional()
      .meta({ description: "Key the mandate is bound to (the agent's session key). Optional in v1." }),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    agent_id: z
      .string()
      .min(1)
      .meta({ description: "Agent Bank extension: agent the mandate is granted to" }),
    description: z
      .string()
      .max(2000)
      .optional()
      .meta({ description: "Agent Bank extension: natural-language intent shown to the principal" }),
  })
  .strict()
  .refine((m) => m.exp > m.iat, { message: "exp must be after iat" })
  .meta({ id: "OpenPaymentMandate", description: "AP2 v0.2 open Payment Mandate (Agent Bank profile)." });

export type OpenPaymentMandate = z.infer<typeof OpenPaymentMandateSchema>;

/** Convert an AP2 minor-unit amount in `currency` to USDC micro-units. */
export function mandateAmountToUsdcMinor(amount: number | string, currency: "USD" | "USDC"): bigint {
  const value = BigInt(amount);
  return currency === "USD" ? value * 10_000n : value;
}
