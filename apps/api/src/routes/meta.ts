import { API_VERSION } from "@agentbank/core/api";
import { getAddress } from "viem";
import { cosignerAddress, usdcAddress, usdcDomain } from "../domain/chain";
import type { Handlers } from "../http/registry";
import { Envelope } from "../http/registry";

const CONTRACT_KEYS: Record<string, string> = {
  entryPoint: "entry_point",
  usdc: "usdc",
  safeSingleton: "safe_singleton",
  safeProxyFactory: "safe_proxy_factory",
  safe7579: "safe7579",
  safe7579Launchpad: "safe7579_launchpad",
  smartSessions: "smart_sessions",
  ownableValidator: "ownable_validator",
  escrow: "escrow",
  streams: "streams",
  vaults: "vaults",
  policyHook: "policy_hook",
  topUpExecutor: "top_up_executor",
  sweepExecutor: "sweep_executor",
  attestationRegistry: "attestation_registry",
  claimsVerifier: "claims_verifier",
};

export const metaHandlers: Pick<Handlers, "health" | "getMeta"> = {
  /**
   * `GET /healthz`: liveness plus dependency checks. The database must answer (otherwise 503).
   * An unreachable co-signer makes the API `degraded` (200): it stays up, and every payment
   * fails closed until the co-signer is back.
   */
  async health(_input, { deps }) {
    const checks: Record<string, string> = {};
    let dbOk = true;
    try {
      await deps.db.query("SELECT 1");
      checks.db = "ok";
    } catch {
      dbOk = false;
      checks.db = "unavailable";
    }
    const cosignerOk = await deps.cosigner.health().then(
      (health) => {
        checks.cosigner = health.status === "ok" ? "ok" : "degraded";
        return health.status === "ok";
      },
      () => {
        checks.cosigner = "unavailable";
        return false;
      },
    );
    checks.chain = deps.config.chain.name;
    const status: "ok" | "degraded" = dbOk && cosignerOk ? "ok" : "degraded";
    return new Envelope({ status, checks }, dbOk ? 200 : 503);
  },

  /** `GET /v1/meta`: deployment facts clients need to build and sign requests. */
  async getMeta(_input, { deps }) {
    const { config } = deps;
    const contracts: Record<string, string> = {};
    for (const [key, name] of Object.entries(CONTRACT_KEYS)) {
      const value = (deps.chain.contracts as unknown as Record<string, unknown>)[key];
      if (typeof value === "string") contracts[name] = getAddress(value);
    }
    const cosigner: string | null = await cosignerAddress(deps).catch(() => null);
    const domain = usdcDomain(deps);
    return {
      object: "meta",
      api_version: API_VERSION,
      chain: config.chain.name,
      chain_id: config.chain.id,
      caip2: config.chain.caip2,
      owner_authorization_chain_id: config.chain.id,
      usdc: {
        address: usdcAddress(deps),
        decimals: 6,
        eip712_name: domain.name,
        eip712_version: domain.version,
      },
      contracts,
      cosigner_address: cosigner,
      revenue_address: getAddress(config.revenueAddress),
      facilitator_url: config.facilitatorUrl,
      features: {
        escrow: config.features.escrow,
        streams: config.features.streams,
        treasury_sweep: config.features.treasurySweep,
        private_proofs: config.features.privateProofs,
        open_signup: config.allowOpenSignup,
        // The faucet mints test USDC on the simulated chain and Anvil only (POST /v1/sandbox/faucet).
        sandbox_faucet: config.chain.name !== "base-sepolia",
      },
    };
  },
};
