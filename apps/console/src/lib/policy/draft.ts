import { PolicyDocumentSchema, type PolicyDocument } from "@agentbank/core";
import { compilePolicy } from "@agentbank/policy";

/**
 * The policy editor works on a loose JSON draft so the form and the JSON view
 * can hold half-typed values (`"25."`) and still show precise errors. The
 * draft is validated with `PolicyDocumentSchema` plus the engine's own
 * semantic checks (`compilePolicy`) before anything is signed or sent.
 */

export type Draft = Record<string, unknown>;
export type Path = readonly (string | number)[];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getIn(source: unknown, path: Path): unknown {
  let node: unknown = source;
  for (const key of path) {
    if (Array.isArray(node) && typeof key === "number") node = node[key];
    else if (isObject(node) && typeof key === "string") node = node[key];
    else return undefined;
  }
  return node;
}

/** Immutable set; `undefined` deletes the key (or array element). */
export function setIn(source: unknown, path: Path, value: unknown): Draft {
  return setAt(source, path, 0, value) as Draft;
}

function setAt(node: unknown, path: Path, i: number, value: unknown): unknown {
  if (i === path.length) return value;
  const key = path[i];
  if (typeof key === "number") {
    const list = Array.isArray(node) ? [...(node as unknown[])] : [];
    const next = setAt(list[key], path, i + 1, value);
    if (next === undefined && i === path.length - 1) list.splice(key, 1);
    else list[key] = next;
    return list;
  }
  const object = isObject(node) ? { ...node } : {};
  const next = setAt(object[key as string], path, i + 1, value);
  if (next === undefined) delete object[key as string];
  else object[key as string] = next;
  return object;
}

/** Drop optional objects and lists that ended up empty while editing. */
export function prune(draft: Draft): Draft {
  const out: Draft = { ...draft };
  for (const key of ["velocity", "auto_save"]) {
    if (isObject(out[key]) && Object.keys(out[key] as object).length === 0) delete out[key];
  }
  // An empty approval ladder means "no approvals". (An empty allowed_kinds list is kept: it forbids every kind.)
  if (Array.isArray(out.approvals) && out.approvals.length === 0) delete out.approvals;
  if (isObject(out.counterparties)) {
    const cp: Record<string, unknown> = { ...out.counterparties };
    for (const list of ["addresses", "agent_ids", "erc8004_ids", "x402_domains", "caps"]) {
      if (Array.isArray(cp[list]) && (cp[list] as unknown[]).length === 0) delete cp[list];
    }
    if (isObject(cp.deny)) {
      const deny: Record<string, unknown> = { ...cp.deny };
      for (const list of Object.keys(deny)) {
        if (Array.isArray(deny[list]) && (deny[list] as unknown[]).length === 0) delete deny[list];
      }
      if (Object.keys(deny).length === 0) delete cp.deny;
      else cp.deny = deny;
    }
    out.counterparties = cp;
  }
  return out;
}

export interface DraftIssue {
  path: string;
  message: string;
}

export type DraftValidation =
  { ok: true; document: PolicyDocument; issues: [] } | { ok: false; document: null; issues: DraftIssue[] };

/** Schema validation (with defaults applied) followed by the engine's semantic checks. */
export function validateDraft(draft: unknown): DraftValidation {
  const parsed = PolicyDocumentSchema.safeParse(draft);
  if (!parsed.success) {
    return {
      ok: false,
      document: null,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    };
  }
  try {
    compilePolicy(parsed.data, 0);
  } catch (error) {
    const issues = (error as { extensions?: { issues?: unknown } }).extensions?.issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return {
        ok: false,
        document: null,
        issues: issues.map((i) => ({
          path: Array.isArray((i as { path?: unknown }).path)
            ? (i as { path: unknown[] }).path.map(String).join(".")
            : "",
          message: String((i as { message?: unknown }).message ?? "Invalid"),
        })),
      };
    }
    return {
      ok: false,
      document: null,
      issues: [{ path: "", message: error instanceof Error ? error.message : "The policy is invalid." }],
    };
  }
  return { ok: true, document: parsed.data, issues: [] };
}

/** Issues keyed by dotted path, for showing errors next to form fields. */
export function issuesByPath(issues: readonly DraftIssue[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const issue of issues) if (!map.has(issue.path)) map.set(issue.path, issue.message);
  return map;
}

/** A conservative starting point for an agent's first policy. */
export function starterPolicy(agentId: string): Draft {
  return {
    agent: agentId,
    asset: "USDC",
    limits: { per_tx: "25.00", per_day: "200.00", per_month: "2000.00" },
    counterparties: { mode: "allowlist", x402_domains: [], new_cooldown_minutes: 60 },
    velocity: { max_per_minute: 30 },
    approvals: [{ above: "100.00", approvers: 1 }],
  };
}

export function toPrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export type JsonParse = { ok: true; value: unknown } | { ok: false; message: string };

export function parseJsonText(text: string): JsonParse {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Invalid JSON" };
  }
}
