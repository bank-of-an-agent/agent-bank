import {
  AgentBankError,
  GENESIS_HASH,
  systemClock,
  type AuditRecord,
  type AuthorizeX402Internal,
  type Clock,
  type CosignerClient,
  type CosignerHealth,
  type CosignInternal,
  type CosignResultInternal,
  type DecisionInternal,
  type DecisionOutcome,
  type EvaluateInternal,
  type FreezeInternal,
  type PolicyStateInternal,
  type PolicyVersionInternal,
  type PutPolicyInternal,
  type RegisterMandateInternal,
  type RegisterSessionInternal,
  type RegisterSpendKeyInternal,
  type RotateOwnerInternal,
  type SetTreasuryInternal,
  type SettlementReportInternal,
  type TypedDataVerifier,
  type UnfreezeInternal,
} from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { Address } from "viem";
import * as authority from "./authority";
import {
  noopAuditExporter,
  type AuditExporter,
  type Logger,
  type ServiceConfig,
  type ServiceContext,
} from "./context";
import { PolicyEvaluator } from "./evaluator";
import type { DecisionResult, DecisionRoute, Metrics } from "./metrics";
import type { OperationCodec } from "./operation";
import * as payments from "./payments";
import type { CosignerSigner } from "./signer/types";
import * as store from "./store";

export type { AuditExporter, Logger, ServiceConfig } from "./context";

export interface CosignerServiceDeps {
  db: SqlClient;
  signer: CosignerSigner;
  /** A `ChainGateway` or any codec with the same pure hash and decode functions. */
  chain: OperationCodec;
  config: ServiceConfig;
  clock?: Clock;
  metrics?: Metrics;
  /** Verifies owner EIP-712 signatures; defaults to EOA verification. */
  ownerVerifier?: TypedDataVerifier;
  /** Receives committed audit records (e.g. an S3 Object Lock exporter); default: none. */
  auditExporter?: AuditExporter;
  logger?: Logger;
}

function resultOutcome(
  value: DecisionInternal | CosignResultInternal | { decision: DecisionInternal },
): DecisionOutcome {
  return "decision" in value ? value.decision.outcome : value.outcome;
}

/**
 * The co-signer: an independent policy authority that adds (or refuses) the
 * second signature on agent operations. It trusts nothing the API says about
 * an operation: it re-derives the user operation hash and the calls from the
 * raw operation, verifies the session key's signature, evaluates its own copy
 * of the policy against its own spend history, and fails closed on any error.
 *
 * Flows live in `authority.ts` (sessions, policies, mandates, freezes) and
 * `payments.ts` (evaluate, cosign, x402, settlements).
 */
export class CosignerService implements CosignerClient {
  readonly #ctx: ServiceContext;

  constructor(deps: CosignerServiceDeps) {
    if (deps.chain.chainId !== deps.config.chainId) {
      throw new Error(
        `Chain codec is for chain ${deps.chain.chainId}, the co-signer serves ${deps.config.chainId}`,
      );
    }
    this.#ctx = {
      db: deps.db,
      signer: deps.signer,
      chain: deps.chain,
      config: deps.config,
      clock: deps.clock ?? systemClock,
      evaluator: new PolicyEvaluator(deps.config.chainId),
      exporter: deps.auditExporter ?? noopAuditExporter,
      metrics: deps.metrics,
      verifier: deps.ownerVerifier,
      log: deps.logger,
    };
  }

  get address(): Address {
    return this.#ctx.signer.address;
  }

  get failClosed(): boolean {
    return this.#ctx.config.failClosed;
  }

  // ---------------------------------------------------------------- authority

  registerSession(input: RegisterSessionInternal): Promise<void> {
    return authority.registerSession(this.#ctx, input);
  }

  revokeSession(sessionId: string): Promise<void> {
    return authority.revokeSession(this.#ctx, sessionId);
  }

  putPolicy(input: PutPolicyInternal): Promise<PolicyVersionInternal> {
    return authority.putPolicy(this.#ctx, input);
  }

  getPolicy(agentId: string): Promise<PolicyStateInternal> {
    return authority.getPolicy(this.#ctx, agentId);
  }

  registerMandate(input: RegisterMandateInternal): Promise<void> {
    return authority.registerMandate(this.#ctx, input);
  }

  revokeMandate(mandateId: string): Promise<void> {
    return authority.revokeMandate(this.#ctx, mandateId);
  }

  registerSpendKey(input: RegisterSpendKeyInternal): Promise<void> {
    return authority.registerSpendKey(this.#ctx, input);
  }

  setTreasury(input: SetTreasuryInternal): Promise<void> {
    return authority.setTreasury(this.#ctx, input);
  }

  rotateOwner(input: RotateOwnerInternal): Promise<void> {
    return authority.rotateOwner(this.#ctx, input);
  }

  freeze(input: FreezeInternal): Promise<void> {
    return authority.freeze(this.#ctx, input);
  }

  unfreeze(input: UnfreezeInternal): Promise<{ effective_at: string }> {
    return authority.unfreeze(this.#ctx, input);
  }

  // ---------------------------------------------------------------- decisions

  evaluate(input: EvaluateInternal): Promise<DecisionInternal> {
    return this.#timed("evaluate", () => payments.evaluate(this.#ctx, input));
  }

  cosign(input: CosignInternal): Promise<CosignResultInternal> {
    return this.#timed("cosign", () => payments.cosign(this.#ctx, input));
  }

  authorizeX402(input: AuthorizeX402Internal): Promise<{ decision: DecisionInternal }> {
    return this.#timed("x402", () => payments.authorizeX402(this.#ctx, input));
  }

  reportSettlement(input: SettlementReportInternal): Promise<void> {
    return payments.reportSettlement(this.#ctx, input);
  }

  // ---------------------------------------------------------------- audit & health

  /** Audit records after `afterSeq`, oldest first. */
  audit(afterSeq = 0, limit = 100): Promise<AuditRecord[]> {
    return store.listAudit(this.#ctx.db, afterSeq, limit);
  }

  /** Verify the whole hash chain (expensive: for audits, incident review and tests, not health checks). */
  verifyAudit(): Promise<store.AuditVerification> {
    return store.verifyAuditLog(this.#ctx.db);
  }

  async health(): Promise<CosignerHealth> {
    const { db, signer, config } = this.#ctx;
    const checks: Record<string, string> = {};
    let healthy = true;
    try {
      const { rows } = await db.query<{ seq: bigint; head: string; last: string | null }>(
        "SELECT h.seq, h.hash AS head, l.hash AS last FROM audit_head h LEFT JOIN audit_log l ON l.seq = h.seq WHERE h.id = 1",
      );
      checks.database = "ok";
      const row = rows[0];
      const consistent =
        row !== undefined && (row.seq === 0n ? row.head === GENESIS_HASH : row.last === row.head);
      checks.audit_chain = consistent ? "ok" : "head does not match the last record";
      if (!consistent) healthy = false;
    } catch {
      checks.database = "unavailable";
      healthy = false;
    }
    checks.signer = signer.kind;
    checks.chain_id = String(config.chainId);
    checks.owner_authorization_chain_id = String(config.ownerAuthorizationChainId ?? config.chainId);
    if (config.failClosed) checks.fail_closed = "COSIGNER_FAIL_CLOSED=true: every decision is refused";
    return {
      status: healthy && !config.failClosed ? "ok" : "degraded",
      cosigner_address: signer.address,
      signer: signer.kind,
      fail_closed: config.failClosed,
      checks,
    };
  }

  async #timed<T extends DecisionInternal | CosignResultInternal | { decision: DecisionInternal }>(
    route: DecisionRoute,
    run: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    let outcome: DecisionResult = "error";
    try {
      const value = await run();
      outcome = resultOutcome(value);
      return value;
    } catch (error) {
      if (!(error instanceof AgentBankError) || error.status >= 500) {
        this.#ctx.log?.error({ err: error, route }, "decision failed; refusing (fail closed)");
      }
      throw error;
    } finally {
      this.#ctx.metrics?.observeDecision(route, outcome, (performance.now() - started) / 1000);
    }
  }
}
