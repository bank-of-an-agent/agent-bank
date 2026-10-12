import "server-only";
import { CHAINS, type ChainName } from "@agentbank/core";
import { Meta } from "@agentbank/core/api";
import { serverConfig } from "./env";
import { upstreamJson } from "./upstream";

/**
 * Deployment facts from the API's public `GET /v1/meta`: the chain, the
 * EIP-712 chain id owner authorizations must use
 * (`owner_authorization_chain_id`) and feature flags such as
 * `treasury_sweep`. Cached for a few minutes; when the API cannot be reached
 * the console falls back to `NEXT_PUBLIC_AGENTBANK_CHAIN` and no features.
 */

export interface Deployment {
  chain: ChainName;
  /** EIP-712 domain chain id for owner authorizations. */
  chainId: number;
  features: Record<string, boolean>;
  source: "api" | "config";
}

const TTL_MS = 5 * 60_000;
/** A failed lookup is retried after this long, so an API outage does not slow every page. */
const FALLBACK_TTL_MS = 30_000;
let cached: { value: Deployment; at: number } | undefined;

export async function resolveDeployment(): Promise<Deployment> {
  const cfg = serverConfig();
  if (cached) {
    const age = Date.now() - cached.at;
    if (age < (cached.value.source === "api" ? TTL_MS : FALLBACK_TTL_MS)) return cached.value;
  }
  try {
    const result = await upstreamJson(cfg.apiUrl, "/v1/meta", { method: "GET", timeoutMs: 2_000 });
    const meta = result.ok ? Meta.safeParse(result.body) : null;
    if (meta?.success) {
      const value: Deployment = {
        chain: meta.data.chain,
        chainId: meta.data.owner_authorization_chain_id,
        features: meta.data.features,
        source: "api",
      };
      cached = { value, at: Date.now() };
      return value;
    }
  } catch {
    // Fall through to configuration.
  }
  const fallback: Deployment = {
    chain: cfg.chain,
    chainId: CHAINS[cfg.chain].id,
    features: {},
    source: "config",
  };
  cached = { value: fallback, at: Date.now() };
  return fallback;
}
