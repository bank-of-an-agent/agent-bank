import type { ChainGateway, PreparedOperation } from "@agentbank/chain";
import {
  AgentBankError,
  newId,
  unixSeconds,
  verifyOwnerAuthorization,
  type Clock,
  type CosignerClient,
  type CosignerHealth,
  type CosignInternal,
  type CosignResultInternal,
  type DecisionInternal,
  type EvaluateInternal,
  type FreezeInternal,
  type PolicyDocument,
  type PolicyStateInternal,
  type PolicyVersionInternal,
  type PutPolicyInternal,
  type RegisterMandateInternal,
  type RegisterSessionInternal,
  type SettlementReportInternal,
  type UnfreezeInternal,
  canonicalKeccak,
  LOOSENING_DELAY_SECONDS,
  ownerPayloads,
  PolicyDocumentSchema,
  OpenPaymentMandateSchema,
  SessionScopeSchema,
} from "@agentbank/core";
import {
  classifyChange,
  compileMandate,
  compilePolicy,
  compileSessionScope,
  effectiveAt,
  evaluate,
  isAuthorized,
  requiresOwnerSignature,
  toPolicyDecisionWire,
  type Decision,
  type EvaluationContext,
  type IntentCounterparty,
} from "@agentbank/policy";
import { recoverMessageAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/**
 * In-process stand-in for apps/cosigner, built on `@agentbank/policy`. It keeps its own copy
 * of sessions, policies, mandates, freezes and spend history like the real co-signer, verifies
 * owner authorizations and session signatures, re-derives operations through the chain
 * gateway (hash and decoded calls, never the API's description) and signs with a local key.
 * `available = false` simulates an outage (every call fails like an unreachable co-signer).
 */

interface SessionState extends RegisterSessionInternal {
  revoked: boolean;
}

interface MandateState extends RegisterMandateInternal {
  revoked: boolean;
}

interface SpendRecord {
  paymentId: string;
  agentId: string;
  amount: bigint;
  at: Date;
  counterparty: string;
  failed: boolean;
  sessionId: string | null;
  mandateId: string | null;
}

export interface FakeCosignerCall {
  method: string;
  input: unknown;
}

function lower(v: string | null | undefined): string {
  return (v ?? "").toLowerCase();
}

export class FakeCosigner implements CosignerClient {
  readonly key: PrivateKeyAccount;
  available = true;
  readonly calls: FakeCosignerCall[] = [];
  readonly sessions = new Map<string, SessionState>();
  readonly mandates = new Map<string, MandateState>();
  readonly policies = new Map<string, PolicyVersionInternal[]>();
  readonly frozen = new Map<string, { reason: string; unfreezeAt: Date | null }>();
  readonly spend: SpendRecord[] = [];
  readonly firstSeen = new Map<string, Date>();
  /** Spend keys pinned per account on the first x402 authorization (as the real co-signer does). */
  readonly spendKeys = new Map<string, string>();
  /** Agent → org, learned from sessions/policies. */
  private readonly agentOrg = new Map<string, string>();

  constructor(
    private readonly clock: Clock,
    private readonly chain: () => ChainGateway | undefined,
    privateKey: Hex = generatePrivateKey(),
  ) {
    this.key = privateKeyToAccount(privateKey);
  }

  get address(): Address {
    return this.key.address;
  }

  private enter(method: string, input: unknown): Date {
    this.calls.push({ method, input });
    if (!this.available) throw new AgentBankError("cosigner_unavailable", "fake co-signer is down");
    return this.clock.now();
  }

  private isFrozen(scope: "org" | "agent" | "session", id: string, now: Date): boolean {
    const f = this.frozen.get(`${scope}:${id}`);
    if (!f) return false;
    if (f.unfreezeAt && f.unfreezeAt.getTime() <= now.getTime()) {
      this.frozen.delete(`${scope}:${id}`);
      return false;
    }
    return true;
  }

  private currentPolicy(agentId: string, now: Date): PolicyVersionInternal | null {
    const versions = this.policies.get(agentId) ?? [];
    let current: PolicyVersionInternal | null = null;
    for (const v of versions) if (new Date(v.effective_at).getTime() <= now.getTime()) current = v;
    return current;
  }

  // ---------------------------------------------------------------- authority

  async registerSession(input: RegisterSessionInternal): Promise<void> {
    const now = this.enter("registerSession", input);
    const scope = SessionScopeSchema.parse(input.scope);
    await verifyOwnerAuthorization({
      chainId: input.chain_id,
      ...ownerPayloads.sessionGrant({ account_id: input.account_id, public_key: input.public_key, scope }),
      issuedAt: input.owner_authorization.issued_at,
      expiresAt: input.owner_authorization.expires_at,
      owner: input.owner_address as Address,
      signer: input.owner_authorization.signer as Address,
      signature: input.owner_authorization.signature as Hex,
      now: unixSeconds(now),
    });
    this.agentOrg.set(input.agent_id, input.org_id);
    this.sessions.set(input.session_id, { ...input, scope, revoked: false });
  }

  async revokeSession(sessionId: string): Promise<void> {
    this.enter("revokeSession", { sessionId });
    const s = this.sessions.get(sessionId);
    if (s) s.revoked = true;
  }

  async putPolicy(input: PutPolicyInternal): Promise<PolicyVersionInternal> {
    const now = this.enter("putPolicy", input);
    const versions = this.policies.get(input.agent_id) ?? [];
    const latest = versions[versions.length - 1] ?? null;
    const policy: PolicyDocument = PolicyDocumentSchema.parse(input.policy);
    const classification = classifyChange(latest ? latest.policy : null, policy);
    const kind = classification.kind;
    let signedBy: string | null = null;
    const touchesAutoSave = classification.neutral.some(
      (p) => p === "auto_save" || p.startsWith("auto_save."),
    );
    if (requiresOwnerSignature(kind) || touchesAutoSave) {
      if (!input.owner_authorization) {
        throw new AgentBankError("owner_signature_required", "Loosening requires an owner authorization");
      }
      await verifyOwnerAuthorization({
        chainId: input.chain_id,
        ...ownerPayloads.policyLoosen(input.agent_id, policy),
        issuedAt: input.owner_authorization.issued_at,
        expiresAt: input.owner_authorization.expires_at,
        owner: input.owner_address as Address,
        signer: input.owner_authorization.signer as Address,
        signature: input.owner_authorization.signature as Hex,
        now: unixSeconds(now),
      });
      signedBy = input.owner_authorization.signer;
    }
    const version: PolicyVersionInternal = {
      agent_id: input.agent_id,
      version: (latest?.version ?? 0) + 1,
      policy,
      policy_hash: canonicalKeccak(policy),
      change_kind: kind,
      effective_at: effectiveAt(kind, now).toISOString(),
      signed_by: signedBy,
    };
    this.agentOrg.set(input.agent_id, input.org_id);
    this.policies.set(input.agent_id, [...versions, version]);
    return version;
  }

  async getPolicy(agentId: string): Promise<PolicyStateInternal> {
    const now = this.enter("getPolicy", { agentId });
    const versions = this.policies.get(agentId) ?? [];
    const current = this.currentPolicy(agentId, now);
    const pending = versions.find((v) => new Date(v.effective_at).getTime() > now.getTime()) ?? null;
    return { current, pending };
  }

  async registerMandate(input: RegisterMandateInternal): Promise<void> {
    const now = this.enter("registerMandate", input);
    const mandate = OpenPaymentMandateSchema.parse(input.mandate);
    await verifyOwnerAuthorization({
      chainId: input.chain_id,
      ...ownerPayloads.mandateIssue(input.agent_id, mandate),
      issuedAt: input.owner_authorization.issued_at,
      expiresAt: input.owner_authorization.expires_at,
      owner: input.owner_address as Address,
      signer: input.owner_authorization.signer as Address,
      signature: input.owner_authorization.signature as Hex,
      now: unixSeconds(now),
    });
    this.mandates.set(input.mandate_id, { ...input, mandate, revoked: false });
  }

  async setTreasury(input: Parameters<CosignerClient["setTreasury"]>[0]): Promise<void> {
    this.enter("setTreasury", input);
  }

  async rotateOwner(input: Parameters<CosignerClient["rotateOwner"]>[0]): Promise<void> {
    this.enter("rotateOwner", input);
  }

  /** Pin the account's x402 spend key (the real co-signer verifies the `spend_key.set` authorization). */
  async registerSpendKey(input: Parameters<CosignerClient["registerSpendKey"]>[0]): Promise<void> {
    this.enter("registerSpendKey", input);
    const pinned = this.spendKeys.get(input.account_id);
    if (pinned && lower(pinned) !== lower(input.spend_key_address)) {
      throw new AgentBankError("conflict", "The account already has another spend key");
    }
    this.spendKeys.set(input.account_id, input.spend_key_address);
  }

  async revokeMandate(mandateId: string): Promise<void> {
    this.enter("revokeMandate", { mandateId });
    const m = this.mandates.get(mandateId);
    if (m) m.revoked = true;
  }

  async freeze(input: FreezeInternal): Promise<void> {
    this.enter("freeze", input);
    this.frozen.set(`${input.scope}:${input.id}`, { reason: input.reason, unfreezeAt: null });
  }

  async unfreeze(input: UnfreezeInternal): Promise<{ effective_at: string }> {
    const now = this.enter("unfreeze", input);
    const canonical =
      input.scope === "org"
        ? ownerPayloads.orgUnfreeze(input.id, input.reason)
        : ownerPayloads.agentUnfreeze(input.id, input.reason);
    await verifyOwnerAuthorization({
      chainId: input.chain_id,
      ...canonical,
      issuedAt: input.owner_authorization.issued_at,
      expiresAt: input.owner_authorization.expires_at,
      owner: input.owner_address as Address,
      signer: input.owner_authorization.signer as Address,
      signature: input.owner_authorization.signature as Hex,
      now: unixSeconds(now),
    });
    const at = new Date(now.getTime() + LOOSENING_DELAY_SECONDS * 1000);
    const f = this.frozen.get(`${input.scope}:${input.id}`);
    if (f) f.unfreezeAt = at;
    return { effective_at: at.toISOString() };
  }

  // ---------------------------------------------------------------- decisions

  private context(
    input: {
      org_id: string;
      agent_id: string;
      account_id?: string;
      session_id?: string | undefined;
      mandate_id?: string | undefined;
    },
    intent: {
      kind: EvaluationContext["intent"]["kind"];
      amount: bigint;
      counterparty: IntentCounterparty;
      contract?: string | null;
    },
    now: Date,
  ): EvaluationContext {
    const key = lower(
      intent.counterparty.address ?? intent.counterparty.x402Domain ?? intent.counterparty.agentId,
    );
    const live = this.spend.filter((s) => s.agentId === input.agent_id && !s.failed);
    const within = (ms: number) => live.filter((s) => now.getTime() - s.at.getTime() < ms);
    const sum = (rows: SpendRecord[]) => rows.reduce((a, s) => a + s.amount, 0n);
    const DAY = 86_400_000;
    let session: EvaluationContext["session"] = null;
    if (input.session_id) {
      const s = this.sessions.get(input.session_id);
      if (s) {
        session = {
          scope: compileSessionScope(s.scope),
          spentToday: sum(within(DAY).filter((r) => r.sessionId === input.session_id)),
          revokedAt: s.revoked ? now : null,
        };
      }
    }
    let mandate: EvaluationContext["mandate"] = null;
    if (input.mandate_id) {
      const m = this.mandates.get(input.mandate_id);
      if (!m || m.revoked) throw new AgentBankError("mandate_invalid", "Unknown or revoked mandate");
      const used = live.filter((s) => s.mandateId === input.mandate_id);
      mandate = { mandate: compileMandate(m.mandate), spent: sum(used), occurrences: used.length };
    }
    return {
      now,
      agent: {
        id: input.agent_id,
        status: this.isFrozen("agent", input.agent_id, now) ? "frozen" : "active",
        spendKeyAddress: input.account_id ? (this.spendKeys.get(input.account_id) ?? null) : null,
      },
      org: { status: this.isFrozen("org", input.org_id, now) ? "frozen" : "active" },
      intent: {
        kind: intent.kind,
        amount: intent.amount,
        asset: "USDC",
        counterparty: intent.counterparty,
        contract: intent.contract ?? null,
      },
      history: {
        spentLastDay: sum(within(DAY)),
        spentLastWeek: sum(within(7 * DAY)),
        spentLastMonth: sum(within(30 * DAY)),
        countLastMinute: within(60_000).length,
        countLastHour: within(3_600_000).length,
        countLastDay: within(DAY).length,
        counterpartySpentLastDay: sum(within(DAY).filter((s) => s.counterparty === key)),
        counterpartySpentLastMonth: sum(within(30 * DAY).filter((s) => s.counterparty === key)),
        counterpartyFirstSeenAt: this.firstSeen.get(`${input.agent_id}|${key}`) ?? null,
      },
      mandate,
      session,
    };
  }

  private decide(
    input: {
      org_id: string;
      agent_id: string;
      account_id?: string;
      session_id?: string | undefined;
      mandate_id?: string | undefined;
    },
    intent: {
      kind: EvaluationContext["intent"]["kind"];
      amount: bigint;
      counterparty: IntentCounterparty;
      contract?: string | null;
    },
    now: Date,
  ): Decision {
    const current = this.currentPolicy(input.agent_id, now);
    const compiled = current ? compilePolicy(current.policy, current.version) : null;
    const ctx = this.context(input, intent, now);
    const key = lower(
      intent.counterparty.address ?? intent.counterparty.x402Domain ?? intent.counterparty.agentId,
    );
    if (!this.firstSeen.has(`${input.agent_id}|${key}`)) this.firstSeen.set(`${input.agent_id}|${key}`, now);
    return evaluate(compiled, ctx);
  }

  private wire(decision: Decision): DecisionInternal {
    return { ...toPolicyDecisionWire(decision), id: newId("decision", decision.evaluatedAt.getTime()) };
  }

  async evaluate(input: EvaluateInternal): Promise<DecisionInternal> {
    const now = this.enter("evaluate", input);
    const decision = this.decide(
      input,
      {
        kind: input.intent.kind,
        amount: BigInt(input.intent.amount),
        counterparty: {
          address: input.intent.counterparty.address ?? null,
          agentId: input.intent.counterparty.agent_id ?? null,
          erc8004Id: input.intent.counterparty.erc8004_id ?? null,
          x402Domain: input.intent.counterparty.x402_domain ?? null,
        },
        contract: input.intent.counterparty.contract ?? null,
      },
      now,
    );
    return this.wire(decision);
  }

  async cosign(input: CosignInternal): Promise<CosignResultInternal> {
    const now = this.enter("cosign", input);
    const chain = this.chain();
    if (!chain)
      throw new AgentBankError("cosigner_unavailable", "no chain configured for the fake co-signer");
    const op = input.operation as unknown as PreparedOperation;
    const refuse = (rule: string, detail: string): CosignResultInternal => ({
      decision: {
        id: newId("decision", now.getTime()),
        outcome: "deny",
        rule_hits: [{ rule, effect: "deny", detail }],
        approvers_required: 0,
        policy_version: this.currentPolicy(input.agent_id, now)?.version ?? 0,
        evaluated_at: now.toISOString(),
      },
      signature: null,
      cosigner_address: this.key.address,
    });
    const hash = chain.hashOperation(op);
    if (hash.toLowerCase() !== input.user_op_hash.toLowerCase())
      return refuse("cosigner.hash_mismatch", "user_op_hash does not match the operation");
    const session = this.sessions.get(input.session_id);
    if (!session || session.revoked) return refuse("session.revoked", "Unknown or revoked session");
    if (new Date(session.scope.expires_at).getTime() <= now.getTime())
      return refuse("session.expired", "Session expired");
    if (lower(session.account_address) !== lower(op.account))
      return refuse("session.account", "Session belongs to another account");
    const signer = await recoverMessageAddress({
      message: { raw: hash },
      signature: input.session_signature as Hex,
    });
    if (lower(signer) !== lower(session.public_key))
      return refuse("session.signature", "Session signature invalid");
    // Re-derive what moves from the raw operation: the largest outflow call must match the intent.
    const calls = chain.decodeOperation(op);
    const CONTROL = new Set([
      "escrow_release",
      "escrow_refund",
      "escrow_dispute",
      "stream_cancel",
      "stream_settle",
    ]);
    if (calls.length > 0 && calls.every((c) => CONTROL.has(c.kind))) {
      // Follow-ups on funds already committed (release, refund, dispute, cancel): no new outflow.
      const signatureControl = await this.key.signMessage({ message: { raw: hash } });
      return {
        decision: {
          id: newId("decision", now.getTime()),
          outcome: "allow",
          rule_hits: [
            { rule: "cosigner.control_call", effect: "info", detail: calls.map((c) => c.kind).join(",") },
          ],
          approvers_required: 0,
          policy_version: this.currentPolicy(input.agent_id, now)?.version ?? 0,
          evaluated_at: now.toISOString(),
        },
        signature: signatureControl,
        cosigner_address: this.key.address,
      };
    }
    const outflow = calls.find(
      (c) =>
        (c.kind === "erc20_transfer" ||
          c.kind === "escrow_lock" ||
          c.kind === "stream_create" ||
          c.kind === "vault_deposit") &&
        c.amount !== undefined &&
        BigInt(c.amount) === BigInt(input.intent.amount),
    );
    if (!outflow) return refuse("cosigner.intent_mismatch", "The operation does not move the stated amount");
    const decision = this.decide(
      input,
      {
        kind: input.intent.kind,
        amount: BigInt(input.intent.amount),
        counterparty: {
          address: input.intent.counterparty.address ?? outflow.recipient ?? null,
          agentId: input.intent.counterparty.agent_id ?? null,
          erc8004Id: input.intent.counterparty.erc8004_id ?? null,
          x402Domain: input.intent.counterparty.x402_domain ?? null,
        },
        contract:
          input.intent.counterparty.contract ?? (outflow.kind === "erc20_transfer" ? null : outflow.to),
      },
      now,
    );
    const approvals = input.approval ? new Set(input.approval.approved_by).size : 0;
    if (!isAuthorized(decision, { approvals })) {
      return { decision: this.wire(decision), signature: null, cosigner_address: this.key.address };
    }
    this.spend.push({
      paymentId: input.payment_id,
      agentId: input.agent_id,
      amount: BigInt(input.intent.amount),
      at: now,
      counterparty: lower(input.intent.counterparty.address ?? outflow.recipient),
      failed: false,
      sessionId: input.session_id,
      mandateId: input.mandate_id ?? null,
    });
    const signature = await this.key.signMessage({ message: { raw: hash } });
    const allowed: DecisionInternal = { ...this.wire(decision), outcome: "allow" };
    return { decision: allowed, signature, cosigner_address: this.key.address };
  }

  async authorizeX402(
    input: Parameters<CosignerClient["authorizeX402"]>[0],
  ): Promise<{ decision: DecisionInternal }> {
    const now = this.enter("authorizeX402", input);
    const pinned = this.spendKeys.get(input.account_id);
    if (!pinned || lower(pinned) !== lower(input.spend_key_address)) {
      // Like the real co-signer: no x402 authorization for an unregistered spend key.
      const refused = this.decide(
        input,
        { kind: "x402", amount: BigInt(input.amount), counterparty: { address: input.pay_to } },
        now,
      );
      const wired = this.wire(refused);
      return {
        decision: {
          ...wired,
          outcome: "deny",
          approvers_required: 0,
          rule_hits: [
            ...wired.rule_hits,
            { rule: "cosigner.spend_key", effect: "deny", detail: "The spend key is not registered" },
          ],
        },
      };
    }
    const decision = this.decide(
      input,
      {
        kind: "x402",
        amount: BigInt(input.amount),
        counterparty: { address: input.pay_to, x402Domain: input.x402_domain },
      },
      now,
    );
    if (decision.outcome === "allow") {
      this.spend.push({
        paymentId: input.payment_id,
        agentId: input.agent_id,
        amount: BigInt(input.amount),
        at: now,
        counterparty: lower(input.x402_domain),
        failed: false,
        sessionId: null,
        mandateId: input.mandate_id ?? null,
      });
    }
    return { decision: this.wire(decision) };
  }

  async reportSettlement(input: SettlementReportInternal): Promise<void> {
    this.enter("reportSettlement", input);
    for (const s of this.spend)
      if (s.paymentId === input.payment_id && input.status === "failed") s.failed = true;
  }

  async health(): Promise<CosignerHealth> {
    this.enter("health", {});
    return {
      status: "ok",
      cosigner_address: this.key.address,
      signer: "local",
      fail_closed: true,
      checks: { db: "ok" },
    };
  }

  /** Calls of one method (assertions in tests). */
  callsTo(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.input);
  }
}
