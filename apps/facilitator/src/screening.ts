/**
 * Wallet-risk screening (OFAC and wallet risk) of the payer and the payee of every payment.
 * Agent Bank buys this from a vendor (Chainalysis, TRM); the sandbox provider uses a small
 * static denylist. Screening fails closed: a provider error, timeout or malformed answer
 * refuses the payment (`screening_unavailable`, HTTP 503) instead of letting it through.
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

/** Addresses the sandbox treats as sanctioned (the same obviously fake set as the API's sandbox). */
export const SANDBOX_SANCTIONED_ADDRESSES: readonly string[] = [
  "0x000000000000000000000000000000000000bad1",
  "0x000000000000000000000000000000000000bad2",
  "0x000000000000000000000000000000000000bad3",
];

/** Addresses the sandbox treats as high risk (allowed: only sanctioned or severe risk blocks). */
export const SANDBOX_HIGH_RISK_ADDRESSES: readonly string[] = ["0x000000000000000000000000000000000000f1a6"];

/** Static denylist provider for the sandbox and tests (`SCREENING_DENYLIST` adds addresses). */
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

export class ScreeningUnavailableError extends Error {
  constructor(message = "Wallet screening is unavailable; failing closed") {
    super(message);
    this.name = "ScreeningUnavailableError";
  }
}

const RISK_LEVELS: readonly string[] = ["low", "medium", "high", "severe"];

/** Screen an address; any provider error or malformed result throws {@link ScreeningUnavailableError}. */
export async function screenOrFail(
  provider: ScreeningProvider,
  address: string,
  timeoutMs = 5_000,
): Promise<ScreeningResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: ScreeningResult;
  try {
    result = await Promise.race([
      provider.screen(address),
      new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(
          () => rejectTimeout(new ScreeningUnavailableError("Wallet screening timed out")),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    throw error instanceof ScreeningUnavailableError ? error : new ScreeningUnavailableError();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (
    !result ||
    typeof result.sanctioned !== "boolean" ||
    typeof result.risk !== "string" ||
    !RISK_LEVELS.includes(result.risk)
  ) {
    throw new ScreeningUnavailableError("Wallet screening returned no usable result; failing closed");
  }
  return result;
}

/** Whether a screening result blocks the payment (sanctioned or severe risk). */
export function isBlocked(result: ScreeningResult): boolean {
  return result.sanctioned || result.risk === "severe";
}
