/**
 * KYC/KYB of principals. Agent Bank buys verification from a vendor; this interface is the
 * adapter boundary. The sandbox provider approves immediately so the sandbox works end to end.
 */

export type KycStatus = "pending" | "in_review" | "approved" | "rejected";

export interface KybSubject {
  orgId: string;
  legalName: string;
  kind: "individual" | "company";
  country: string;
  contactEmail: string;
}

export interface KybStartResult {
  provider: string;
  status: KycStatus;
  /** Hosted verification page for the principal, or null when nothing is left to do. */
  verificationUrl: string | null;
  /** The vendor's reference for this verification. */
  reference: string;
}

export interface KybProvider {
  readonly name: string;
  /** Start (or resume) verification for an org. Must be idempotent per org. */
  start(subject: KybSubject): Promise<KybStartResult>;
}

export class SandboxKyb implements KybProvider {
  readonly name = "sandbox";

  async start(subject: KybSubject): Promise<KybStartResult> {
    return {
      provider: this.name,
      status: "approved",
      verificationUrl: null,
      reference: `sandbox:${subject.orgId}`,
    };
  }
}
