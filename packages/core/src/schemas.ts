import { z } from "zod";
import { idPattern, type IdKind } from "./ids";

/**
 * Primitive Zod schemas shared by the API contract, the policy engine and the
 * SDKs. Everything that crosses a process boundary is validated with these.
 */

/** Non-negative decimal string with at most 6 fraction digits (USDC precision). */
export const DecimalString = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/, 'must be a non-negative decimal string, e.g. "25.00"')
  .meta({
    description: 'Decimal string in major units, e.g. "25.00". Never a JSON number.',
    example: "25.00",
  });

/** Signed decimal string (ledger lines). */
export const SignedDecimalString = z
  .string()
  .regex(/^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/)
  .meta({ description: "Signed decimal string in major units.", example: "-25.00" });

export const AssetCodeSchema = z.enum(["USDC"]).meta({ description: "Asset code. USDC only in v1." });

export const MoneySchema = z
  .object({ amount: DecimalString, asset: AssetCodeSchema })
  .meta({ id: "Money", description: "An amount of an asset. Amount is a decimal string." });

export const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte hex address")
  .meta({ description: "EVM address", example: "0x1111111111111111111111111111111111111111" });

export const HexSchema = z.string().regex(/^0x([a-fA-F0-9]{2})*$/, "must be 0x-prefixed hex");
export const Bytes32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be 32 bytes of hex");
export const SignatureSchema = z.string().regex(/^0x([a-fA-F0-9]{2}){65,}$/, "must be a hex signature");

export const TimestampSchema = z.iso.datetime({ offset: true }).meta({ description: "ISO 8601 timestamp" });

export const DomainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/,
    "must be a lowercase hostname",
  )
  .meta({ description: "Lowercase hostname, e.g. api.example-data.com" });

export const ChainNameSchema = z.enum(["base-sepolia", "anvil", "simulated"]);

export function idSchema(kind: IdKind) {
  return z.string().regex(new RegExp(idPattern(kind)), `must be a ${kind} id`);
}

/** Cursor pagination wrapper used by every list endpoint. */
export function page<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), next_cursor: z.string().nullable() });
}

export const PaginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Owner authorization attached to requests that need the principal's owner key. */
export const OwnerAuthorizationSchema = z
  .object({
    signer: AddressSchema.meta({ description: "Owner key address that produced the signature" }),
    signature: HexSchema,
    issued_at: z.number().int().nonnegative().meta({ description: "Unix seconds" }),
    expires_at: z.number().int().positive().meta({ description: "Unix seconds" }),
  })
  .meta({
    id: "OwnerAuthorization",
    description:
      "EIP-712 OwnerAuthorization signature by the org owner key over the canonical request payload. Required for loosening changes and session installs.",
  });

export type OwnerAuthorization = z.infer<typeof OwnerAuthorizationSchema>;
