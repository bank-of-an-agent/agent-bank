import type { JsonSchema } from "./types";

/**
 * JSON Schema → readable Markdown: type labels for table cells and flattened
 * field rows (`to.address`, `limits.per_day`, `constraints[].max`).
 *
 * Everything returned here is safe inside a Markdown table cell that VitePress
 * compiles into a Vue template: no unescaped pipes or newlines, no raw `<`/`>`
 * outside code spans, and no Vue interpolation (`{{`).
 */

/** Resolve a `#/components/schemas/<Name>` reference to its name. */
export function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

/** `CreatePaymentRequest` → `create-payment-request`, `X402PayRequest` → `x402-pay-request`. */
export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** Escape text for a table cell: pipes, angle brackets and Vue braces outside code spans. */
export function cell(text: string): string {
  const oneLine = text.replace(/\s*\n\s*/g, " ").trim();
  return oneLine
    .split(/(`[^`]*`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part.replace(/\|/g, "\\|")
        : part
            .replace(/\|/g, "\\|")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\{\{/g, "&#123;&#123;"),
    )
    .join("");
}

/** Inline code for a JSON value, e.g. `USDC` or `50`. */
export function code(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `\`${text.replace(/`/g, "'")}\``;
}

const ID_RE = /^\^([a-z0-9]+)_\[0-9A-HJKMNP-TV-Z\]\{26\}\$$/;

/** Friendly names for the patterns the API contract uses. */
const KNOWN_PATTERNS: Record<string, string> = {
  "^0x[a-fA-F0-9]{40}$": "address",
  "^0x[a-fA-F0-9]{64}$": "bytes32 hex",
  "^0x([a-fA-F0-9]{2})*$": "hex",
  "^(0|[1-9][0-9]{0,17})(\\.[0-9]{1,6})?$": "decimal string",
  "^-?(0|[1-9][0-9]{0,17})(\\.[0-9]{1,6})?$": "signed decimal string",
  "^(0|[1-9][0-9]{0,18})$": "integer string",
  "^[0-9]+$": "integer string",
  "^[0-9]{4}-(0[1-9]|1[0-2])$": "`YYYY-MM`",
  "^[0-9]{4}-[0-9]{2}$": "`YYYY-MM`",
  "^([01][0-9]|2[0-3]):[0-5][0-9]$": "`HH:MM`",
  "^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$": "`HH:MM` or `24:00`",
  "^[\\x21-\\x7E]{1,200}$": "ERC-8004 id",
  "^(treasury|vault:vlt_[0-9A-HJKMNP-TV-Z]{26})$": "`treasury` or `vault:vlt_…`",
};

function patternLabel(pattern: string): string | undefined {
  const id = ID_RE.exec(pattern);
  if (id) return `\`${id[1]}_…\` id`;
  const known = KNOWN_PATTERNS[pattern];
  if (known) return known;
  if (pattern.startsWith("^(?=.{1,253}$)")) return "hostname";
  return undefined;
}

/** Builds the link to a named schema from the page being rendered. */
export type Linker = (schemaName: string) => string;

function isNull(schema: JsonSchema): boolean {
  return schema.type === "null";
}

/** Split `anyOf`/`oneOf` with a `null` branch into the non-null variants and nullability. */
export function unwrapNullable(schema: JsonSchema): { variants: JsonSchema[]; nullable: boolean } {
  const union = schema.anyOf ?? schema.oneOf;
  if (union) {
    const variants = union.filter((s) => !isNull(s));
    return { variants, nullable: variants.length !== union.length };
  }
  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    const rest = schema.type.filter((t) => t !== "null");
    return { variants: [{ ...schema, type: rest.length === 1 ? rest[0] : rest }], nullable: true };
  }
  return { variants: [schema], nullable: false };
}

/** For unions of objects discriminated by a `type` constant, the constants in order. */
export function discriminatorValues(variants: JsonSchema[]): string[] | undefined {
  if (variants.length < 2) return undefined;
  const values: string[] = [];
  for (const v of variants) {
    const tag = v.properties?.type?.const;
    if (typeof tag !== "string") return undefined;
    values.push(tag);
  }
  return values;
}

/** A one-line Markdown type label. */
export function typeLabel(schema: JsonSchema, link: Linker): string {
  const { variants, nullable } = unwrapNullable(schema);
  const only = variants.length === 1 ? variants[0] : undefined;
  const base = only ? singleLabel(only, link) : unionLabel(variants, link);
  return nullable ? `${base} or null` : base;
}

function unionLabel(variants: JsonSchema[], link: Linker): string {
  const tags = discriminatorValues(variants);
  if (tags) return `object, one of ${tags.length} shapes`;
  return [...new Set(variants.map((v) => singleLabel(v, link)))].join(" or ");
}

function singleLabel(schema: JsonSchema, link: Linker): string {
  if (schema.$ref) {
    const name = refName(schema.$ref);
    return `[${name}](${link(name)})`;
  }
  if (schema.anyOf || schema.oneOf) return typeLabel(schema, link);
  if (schema.const !== undefined) return code(schema.const);
  const type = Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type;
  switch (type) {
    case "string": {
      if (schema.format === "date-time") return "timestamp";
      if (schema.format === "email") return "email";
      if (schema.format === "uri") return "URL";
      return schema.pattern ? (patternLabel(schema.pattern) ?? "string") : "string";
    }
    case "array":
      return schema.items ? `array of ${typeLabel(schema.items, link)}` : "array";
    case "object":
    case undefined: {
      if (schema.properties) return "object";
      const extra = schema.additionalProperties;
      if (extra && typeof extra === "object") return `map of string to ${typeLabel(extra, link)}`;
      return "object";
    }
    default:
      return type;
  }
}

/** Constraints and defaults for the description column. */
export function constraintNotes(schema: JsonSchema): string[] {
  const { variants } = unwrapNullable(schema);
  const s = variants.length === 1 && variants[0] ? variants[0] : schema;
  const notes: string[] = [];
  if (s.enum && s.enum.length > 0) notes.push(`One of ${s.enum.map(code).join(", ")}.`);
  const itemEnum = s.type === "array" ? s.items?.enum : undefined;
  if (itemEnum && itemEnum.length > 0) notes.push(`Each one of ${itemEnum.map(code).join(", ")}.`);
  if (s.minLength !== undefined && s.maxLength !== undefined)
    notes.push(`${s.minLength} to ${s.maxLength} characters.`);
  else if (s.maxLength !== undefined) notes.push(`At most ${s.maxLength} characters.`);
  else if (s.minLength !== undefined && s.minLength > 1) notes.push(`At least ${s.minLength} characters.`);
  const lo = s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : undefined);
  const hi = s.maximum !== undefined && s.maximum < Number.MAX_SAFE_INTEGER ? s.maximum : undefined;
  if (lo !== undefined && hi !== undefined) notes.push(`${lo} to ${hi}.`);
  else if (lo !== undefined && lo > 0) notes.push(`At least ${lo}.`);
  else if (hi !== undefined) notes.push(`At most ${hi}.`);
  if (s.minItems !== undefined && s.maxItems !== undefined)
    notes.push(`${s.minItems} to ${s.maxItems} items.`);
  else if (s.maxItems !== undefined) notes.push(`At most ${s.maxItems} items.`);
  else if (s.minItems !== undefined && s.minItems > 0) notes.push(`At least ${s.minItems} item(s).`);
  if (s.default !== undefined) notes.push(`Default ${code(s.default)}.`);
  return notes;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?)]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Descriptions that only restate the type label ("decimal string", "address", "timestamp"). */
const GENERIC_DESCRIPTIONS = new Set([
  'Decimal string in major units, e.g. "25.00". Never a JSON number.',
  "Signed decimal string in major units.",
  "EVM address",
  "ISO 8601 timestamp",
]);

/** Description column: the schema's own description plus constraints, escaped for a cell. */
export function describe(schema: JsonSchema): string {
  const raw =
    schema.description ??
    unwrapNullable(schema).variants.find((v) => v.description !== undefined)?.description;
  const own = raw !== undefined && !GENERIC_DESCRIPTIONS.has(raw) ? raw : undefined;
  const parts = [own ? sentence(own) : "", ...constraintNotes(schema)].filter((p) => p.length > 0);
  return cell(parts.join(" "));
}

export interface FieldRow {
  path: string;
  type: string;
  required: boolean;
  description: string;
}

interface Child {
  /** Appended to the property path before the dot: `""` for objects, `"[]"` for arrays. */
  suffix: "" | "[]";
  /** Shown before each child row for discriminated unions. */
  note: string | undefined;
  object: JsonSchema;
}

function discriminatedChildren(variants: JsonSchema[], suffix: "" | "[]"): Child[] {
  const tags = discriminatorValues(variants);
  if (!tags) return [];
  return variants.map((object, i) => ({ suffix, note: `Only for ${code(tags[i])}.`, object }));
}

/** The inline objects to descend into (referenced schemas are linked, not expanded). */
function inlineChildren(schema: JsonSchema): Child[] {
  const { variants } = unwrapNullable(schema);
  const only = variants.length === 1 ? variants[0] : undefined;
  if (!only) return discriminatedChildren(variants, "");
  if (only.properties) return [{ suffix: "", note: undefined, object: only }];
  if (only.type === "array" && only.items) {
    const items = unwrapNullable(only.items);
    const item = items.variants.length === 1 ? items.variants[0] : undefined;
    if (item?.properties) return [{ suffix: "[]", note: undefined, object: item }];
    return discriminatedChildren(items.variants, "[]");
  }
  return [];
}

const MAX_DEPTH = 4;

/**
 * Flatten an object schema into rows with dotted paths. Nested inline objects
 * are expanded (up to four levels); referenced schemas are linked instead.
 */
export function flattenFields(schema: JsonSchema, link: Linker, prefix = "", depth = 0): FieldRow[] {
  const rows: FieldRow[] = [];
  const required = new Set(schema.required ?? []);
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const path = `${prefix}${name}`;
    rows.push({
      path,
      type: typeLabel(prop, link),
      required: required.has(name),
      description: describe(prop),
    });
    if (depth + 1 >= MAX_DEPTH) continue;
    for (const child of inlineChildren(prop)) {
      for (const row of flattenFields(child.object, link, `${path}${child.suffix}.`, depth + 1)) {
        const description = child.note ? `${cell(child.note)} ${row.description}`.trim() : row.description;
        rows.push({ ...row, description });
      }
    }
  }
  return rows;
}

/** Render rows as a Markdown table. */
export function fieldTable(rows: FieldRow[], firstColumn = "Field"): string {
  if (rows.length === 0) return "";
  const lines = [`| ${firstColumn} | Type | Required | Description |`, "| --- | --- | --- | --- |"];
  for (const row of rows) {
    lines.push(`| \`${row.path}\` | ${row.type} | ${row.required ? "yes" : "no"} | ${row.description} |`);
  }
  return lines.join("\n");
}
