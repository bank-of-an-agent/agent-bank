import { AgentBankError } from "@agentbank/core";

/**
 * Wallet-risk screening (OFAC and wallet risk) of every counterparty and deposit. Agent Bank
 * buys this from a vendor (Chainalysis, TRM); the sandbox implementation uses a small static
 * denylist. Screening fails closed: any provider error becomes `screening_unavailable` (503)
 * and the payment stops.
 */

export type RiskLevel = "low" | "medium" | "high" | "severe";

export interface ScreeningResult {
  risk: RiskLevel;
  sanctioned: boolean;
  /** Provider that produced the result, e.g. `sandbox`. */
  provider: string;
}

export interface ScreeningProvider {
  screen(address: string): Promise<ScreeningResult>;
}

/** Addresses the sandbox treats as sanctioned. Obviously fake; for tests and demos. */
export const SANDBOX_SANCTIONED_ADDRESSES: readonly string[] = [
  "0x000000000000000000000000000000000000bad1",
  "0x000000000000000000000000000000000000bad2",
  "0x000000000000000000000000000000000000bad3",
];

/** Addresses the sandbox treats as high risk (not sanctioned). */
export const SANDBOX_HIGH_RISK_ADDRESSES: readonly string[] = ["0x000000000000000000000000000000000000f1a6"];

export class SandboxScreening implements ScreeningProvider {
  private readonly sanctioned: Set<string>;
  private readonly highRisk: Set<string>;

  constructor(extraDenylist: readonly string[] = []) {
    this.sanctioned = new Set(
      [...SANDBOX_SANCTIONED_ADDRESSES, ...extraDenylist].map((a) => a.toLowerCase()),
    );
    this.highRisk = new Set(SANDBOX_HIGH_RISK_ADDRESSES.map((a) => a.toLowerCase()));
  }

  async screen(address: string): Promise<ScreeningResult> {
    const a = address.toLowerCase();
    if (this.sanctioned.has(a)) return { risk: "severe", sanctioned: true, provider: "sandbox" };
    if (this.highRisk.has(a)) return { risk: "high", sanctioned: false, provider: "sandbox" };
    return { risk: "low", sanctioned: false, provider: "sandbox" };
  }
}

/** Screen an address, failing closed on any provider error. */
export async function screenOrFail(provider: ScreeningProvider, address: string): Promise<ScreeningResult> {
  let result: ScreeningResult;
  try {
    result = await provider.screen(address);
  } catch {
    throw new AgentBankError("screening_unavailable", "Wallet screening is unavailable; failing closed");
  }
  if (!result || typeof result.sanctioned !== "boolean") {
    throw new AgentBankError("screening_unavailable", "Wallet screening returned no result; failing closed");
  }
  return result;
}

/** Whether a screening result blocks the movement (sanctioned or severe risk). */
export function isBlocked(result: ScreeningResult): boolean {
  return result.sanctioned || result.risk === "severe";
}
