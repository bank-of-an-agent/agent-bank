import { isPrivateKey } from "@agentbank/sdk";

/**
 * Base Sepolia mode for the scenario suite (Phase 3 gate "end-to-end suite on Base Sepolia").
 *
 * The suite runs against the real testnet only when `E2E_CHAIN=base-sepolia` and a human has
 * provided the RPC endpoint, a Pimlico key, funded testnet keys and the deployed contract
 * addresses. No secrets live in the repo, and nothing is ever broadcast unless these are set by
 * a human. Otherwise the gate is skipped with a message listing exactly what to provide.
 */

export interface BaseSepoliaEnv {
  rpcUrl: string;
  pimlicoApiKey: string;
  /** The API's gas relayer (keeper) key — pays for keeper calls and spend-key permits. */
  apiRelayerKey: `0x${string}`;
  /** The facilitator's relayer key — pays gas for x402 settlements. */
  facilitatorRelayerKey: `0x${string}`;
  /** A key holding Base Sepolia test USDC, used to fund freshly created agent accounts. */
  funderKey: `0x${string}`;
  /** The owner key used for the test org (controls the agent accounts). */
  ownerKey: `0x${string}`;
  /** The Agent Bank revenue address. */
  revenueAddress: `0x${string}`;
  /** The contracts deployment JSON (contracts repo `deployments/84532.json`). */
  deploymentJson: string;
  /** Optional Pimlico sponsorship policy id. */
  sponsorshipPolicyId: string | undefined;
}

const REQUIRED: { name: string; describe: string }[] = [
  { name: "BASE_SEPOLIA_RPC_URL", describe: "a Base Sepolia JSON-RPC URL" },
  { name: "PIMLICO_API_KEY", describe: "a Pimlico API key (bundler + paymaster)" },
  { name: "E2E_API_RELAYER_KEY", describe: "a funded testnet key for API keeper calls (0x…)" },
  { name: "E2E_FACILITATOR_RELAYER_KEY", describe: "a funded testnet key for x402 settlement gas (0x…)" },
  { name: "E2E_FUNDER_KEY", describe: "a key holding Base Sepolia test USDC to fund agent accounts (0x…)" },
  { name: "E2E_OWNER_KEY", describe: "the org owner key for the test (0x…)" },
  { name: "E2E_REVENUE_ADDRESS", describe: "the Agent Bank revenue address (0x…)" },
  { name: "AGENTBANK_DEPLOYMENT_JSON", describe: "the contracts deployment JSON for chain 84532" },
];

/** Whether the suite was asked to run against Base Sepolia. */
export function wantsBaseSepolia(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.E2E_CHAIN ?? "").toLowerCase() === "base-sepolia";
}

/** The names of the env vars that are required but missing or malformed. */
export function missingBaseSepoliaEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  for (const { name } of REQUIRED) {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    else if (name.endsWith("_KEY") && name !== "PIMLICO_API_KEY" && !isPrivateKey(value)) {
      missing.push(`${name} (must be a 0x-prefixed 32-byte key)`);
    }
  }
  return missing;
}

/** A human-readable instruction block listing everything a human must provide to run the gate. */
export function baseSepoliaInstructions(): string {
  const lines = [
    "Base Sepolia end-to-end gate (Phase 3) is skipped: it runs only when a human provides the",
    "testnet credentials below and sets E2E_CHAIN=base-sepolia. No secrets are kept in the repo,",
    "and nothing is broadcast unless these are set by a human:",
    "",
    ...REQUIRED.map(({ name, describe }) => `  - ${name}: ${describe}`),
    "",
    "The keys must be funded with Base Sepolia ETH (gas) and the funder with test USDC (Circle's",
    "faucet). Then run: E2E_CHAIN=base-sepolia pnpm --filter @agentbank/e2e gate:phase3",
  ];
  return lines.join("\n");
}

/** Read and validate the Base Sepolia env (throws with the instruction block if anything is missing). */
export function baseSepoliaEnv(env: NodeJS.ProcessEnv = process.env): BaseSepoliaEnv {
  const missing = missingBaseSepoliaEnv(env);
  if (missing.length > 0) {
    throw new Error(
      `Missing Base Sepolia configuration: ${missing.join(", ")}\n\n${baseSepoliaInstructions()}`,
    );
  }
  return {
    rpcUrl: env.BASE_SEPOLIA_RPC_URL as string,
    pimlicoApiKey: env.PIMLICO_API_KEY as string,
    apiRelayerKey: env.E2E_API_RELAYER_KEY as `0x${string}`,
    facilitatorRelayerKey: env.E2E_FACILITATOR_RELAYER_KEY as `0x${string}`,
    funderKey: env.E2E_FUNDER_KEY as `0x${string}`,
    ownerKey: env.E2E_OWNER_KEY as `0x${string}`,
    revenueAddress: env.E2E_REVENUE_ADDRESS as `0x${string}`,
    deploymentJson: env.AGENTBANK_DEPLOYMENT_JSON as string,
    sponsorshipPolicyId: env.PIMLICO_SPONSORSHIP_POLICY_ID?.trim() || undefined,
  };
}
