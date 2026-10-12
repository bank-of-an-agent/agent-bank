import { ROUTE_LIST, type RouteDef } from "@agentbank/core/api";

/**
 * The BFF proxies only routes in the core route registry that a principal
 * (or Agent Bank staff) may call. Agent-only routes (payments created by
 * agents, signatures, x402 pay, private-proof enrollment, witnesses and new
 * reservations) and facilitator routes are not reachable through the console,
 * and neither is anything outside `/v1`. Public routes (e.g. the proof roots)
 * are forwarded with whatever session the browser has, or none.
 */

export type CredentialSource = "principal" | "staff" | "none";

export interface MatchedRoute {
  def: RouteDef;
  params: Record<string, string>;
  credential: CredentialSource;
}

interface CompiledRoute {
  def: RouteDef;
  method: string;
  regex: RegExp;
  paramNames: string[];
  credential: CredentialSource;
}

/** Routes with a dedicated BFF handler instead of the generic proxy. */
const DEDICATED = new Set(["createOrg"]);

export function credentialFor(def: RouteDef): CredentialSource | null {
  if (def.service === "facilitator" || DEDICATED.has(def.operationId)) return null;
  if (def.auth.includes("staff")) return "staff";
  if (def.auth.includes("principal") || def.auth.includes("approver")) return "principal";
  if (def.auth.includes("public")) return "none";
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(def: RouteDef, credential: CredentialSource): CompiledRoute {
  const paramNames: string[] = [];
  const pattern = def.path
    .split("/")
    .map((segment) => {
      const param = /^\{([a-z_]+)\}$/i.exec(segment);
      if (param?.[1]) {
        paramNames.push(param[1]);
        return "([^/]+)";
      }
      return escapeRegex(segment);
    })
    .join("/");
  return { def, method: def.method, regex: new RegExp(`^${pattern}$`), paramNames, credential };
}

const COMPILED: CompiledRoute[] = ROUTE_LIST.flatMap((def) => {
  const credential = credentialFor(def);
  return credential ? [compile(def, credential)] : [];
});

/** Match a method and a decoded path (e.g. `/v1/agents/agt_…/freeze`) against the allowlist. */
export function matchRoute(method: string, path: string): MatchedRoute | null {
  const upper = method.toUpperCase();
  for (const route of COMPILED) {
    if (route.method !== upper) continue;
    const match = route.regex.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = match[i + 1] ?? "";
    });
    return { def: route.def, params, credential: route.credential };
  }
  return null;
}

/** Whether any allowlisted route serves this path with another method (for 405 vs 404). */
export function pathKnown(path: string): boolean {
  return COMPILED.some((route) => route.regex.test(path));
}

/** Query keys the route declares; anything else is dropped before forwarding. */
export function allowedQueryKeys(def: RouteDef): Set<string> {
  const shape = (def.query as { shape?: Record<string, unknown> } | undefined)?.shape;
  return new Set(shape ? Object.keys(shape) : []);
}
