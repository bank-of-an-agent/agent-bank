import { recoverOperationSigner, type DecodedCall, type PreparedOperation } from "@agentbank/chain";
import {
  AddressSchema,
  AgentBankError,
  Bytes32Schema,
  canonicalSha256,
  HexSchema,
  newId,
  type AuthorizeX402Internal,
  type CosignInternal,
  type CosignResultInternal,
  type DecisionInternal,
  type DecisionOutcome,
  type EvaluateInternal,
  type RuleHit,
  type SettlementReportInternal,
} from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import type { IntentCounterparty } from "@agentbank/policy";
import { getAddress, type Hex } from "viem";
import { z } from "zod";
import { assertIds, sameAddress, transaction, type AuditFn, type ServiceContext } from "./context";
import { applyApproval, blocking, hit, refusal, toWire, type FinalDecision } from "./decision";
import { actionFor, matchCalls, movesNothing, type CosignAction, type VerifiedSpend } from "./operation";
import * as store from "./store";

type Source = "evaluate" | "cosign" | "x402";

interface DecisionBase {
  source: Source;
  paymentId: string | null;
  orgId: string;
  agentId: string;
}

const UINT = /^(0|[1-9][0-9]*)$/;
const Uint = z.string().regex(UINT);

/** JSON-safe prepared operation (`PreparedOperation` in packages/chain), validated before use. */
const PreparedOperationSchema = z.looseObject({
  chainId: z.number().int(),
  entryPoint: AddressSchema,
  account: AddressSchema,
  signer: z.enum(["session", "owner"]),
  permissionId: Bytes32Schema.nullable(),
  userOp: z.looseObject({
    sender: AddressSchema,
    nonce: Uint,
    factory: AddressSchema.nullable(),
    factoryData: HexSchema.nullable(),
    callData: HexSchema,
    callGasLimit: Uint,
    verificationGasLimit: Uint,
    preVerificationGas: Uint,
    maxFeePerGas: Uint,
    maxPriorityFeePerGas: Uint,
    paymaster: AddressSchema.nullable(),
    paymasterVerificationGasLimit: Uint.nullable(),
    paymasterPostOpGasLimit: Uint.nullable(),
    paymasterData: HexSchema.nullable(),
    signature: HexSchema,
  }),
  userOpHash: Bytes32Schema.optional(),
  validUntil: z.number().int(),
});

function toCounterparty(cp: {
  address?: string | undefined;
  agent_id?: string | undefined;
  erc8004_id?: string | undefined;
  x402_domain?: string | undefined;
}): IntentCounterparty {
  return {
    address: cp.address ?? null,
    agentId: cp.agent_id ?? null,
    erc8004Id: cp.erc8004_id ?? null,
    x402Domain: cp.x402_domain ?? null,
  };
}

function chainHit(ctx: ServiceContext, chainId: number): RuleHit {
  return hit("cosigner.chain", "deny", `This co-signer serves chain ${ctx.config.chainId}, not ${chainId}`);
}

function decisionRow(id: string, base: DecisionBase, decision: FinalDecision): store.DecisionRow {
  return {
    id,
    source: base.source,
    payment_id: base.paymentId,
    org_id: base.orgId,
    agent_id: base.agentId,
    outcome: decision.outcome,
    rule_hits: decision.ruleHits,
    approvers_required: decision.approversRequired,
    policy_version: decision.policyVersion,
    evaluated_at: decision.evaluatedAt,
    retry_at: decision.retryAt,
  };
}

/** Persist a decision that signs nothing, with its audit record. Returns the decision id. */
async function recordDecision(
  tx: SqlClient,
  audit: AuditFn,
  base: DecisionBase,
  decision: FinalDecision,
  now: Date,
  extra: Record<string, unknown>,
): Promise<string> {
  const id = newId("decision", now.getTime());
  await store.insertDecision(tx, decisionRow(id, base, decision));
  const action =
    base.source === "evaluate"
      ? "decision.evaluated"
      : decision.outcome === "allow"
        ? `${base.source}.allowed`
        : `${base.source}.refused`;
  await audit({
    at: now,
    actor: "api",
    action,
    subject: base.paymentId ?? base.agentId,
    payload: {
      decision_id: id,
      outcome: decision.outcome,
      policy_version: decision.policyVersion,
      org_id: base.orgId,
      agent_id: base.agentId,
      payment_id: base.paymentId,
      reasons: blocking(decision.ruleHits),
      ...extra,
    },
  });
  return id;
}

async function recordRefusal(
  ctx: ServiceContext,
  base: DecisionBase,
  decision: FinalDecision,
  now: Date,
  extra: Record<string, unknown>,
): Promise<DecisionInternal> {
  return transaction(ctx, async (tx, audit) =>
    toWire(decision, await recordDecision(tx, audit, base, decision, now, extra)),
  );
}

/** COSIGNER_FAIL_CLOSED: refuse, and record the refusal if the database lets us (refusing never depends on it). */
async function failClosed(ctx: ServiceContext, base: DecisionBase, now: Date): Promise<DecisionInternal> {
  const decision = refusal(
    [
      hit(
        "cosigner.fail_closed",
        "deny",
        "The co-signer is failing closed (COSIGNER_FAIL_CLOSED=true); nothing is authorized",
      ),
    ],
    now,
  );
  try {
    return await recordRefusal(ctx, base, decision, now, {});
  } catch (error) {
    ctx.log?.warn({ err: error }, "could not record a fail-closed refusal");
    return toWire(decision, newId("decision", now.getTime()));
  }
}

async function originalDecision(tx: SqlClient, id: string): Promise<DecisionInternal | null> {
  const row = await store.getDecision(tx, id);
  if (!row) return null;
  return toWire(
    {
      outcome: row.outcome as DecisionOutcome,
      ruleHits: [...row.rule_hits],
      approversRequired: row.approvers_required,
      policyVersion: row.policy_version,
      evaluatedAt: new Date(row.evaluated_at),
      retryAt: row.retry_at === null ? null : new Date(row.retry_at),
    },
    row.id,
  );
}

function sessionProblem(
  ctx: ServiceContext,
  session: store.SessionRow | null,
  input: {
    org_id: string;
    agent_id: string;
    account_id: string;
    account_address: string;
    session_id?: string | undefined;
  },
): string | null {
  if (!session) return `Unknown session ${input.session_id ?? ""}`.trim();
  if (session.org_id !== input.org_id || session.agent_id !== input.agent_id)
    return `Session ${session.id} belongs to another agent`;
  if (
    session.account_id !== input.account_id ||
    !sameAddress(session.account_address, input.account_address)
  ) {
    return `Session ${session.id} belongs to another account`;
  }
  if (session.chain_id !== ctx.config.chainId)
    return `Session ${session.id} is for chain ${session.chain_id}`;
  return null;
}

// ------------------------------------------------------------------ evaluate (dry run)

/** The decision a payment would get now. Records the decision (and the counterparty's first sight), never spend. */
export async function evaluate(ctx: ServiceContext, input: EvaluateInternal): Promise<DecisionInternal> {
  assertIds({
    org_id: input.org_id,
    agent_id: input.agent_id,
    account_id: input.account_id,
    mandate_id: input.mandate_id,
    session_id: input.session_id,
  });
  const now = ctx.clock.now();
  const base: DecisionBase = {
    source: "evaluate",
    paymentId: null,
    orgId: input.org_id,
    agentId: input.agent_id,
  };
  if (ctx.config.failClosed) return failClosed(ctx, base, now);
  if (input.chain_id !== ctx.config.chainId)
    return recordRefusal(ctx, base, refusal([chainHit(ctx, input.chain_id)], now), now, {});
  return transaction(ctx, async (tx, audit) => {
    const extra: RuleHit[] = [];
    let session: store.SessionRow | null = null;
    if (input.session_id !== undefined) {
      const row = await store.getSession(tx, input.session_id);
      const problem = sessionProblem(ctx, row, input);
      if (problem) extra.push(hit("cosigner.session", "deny", problem));
      else session = row;
    }
    const { decision, keys } = await ctx.evaluator.decide(tx, {
      now,
      orgId: input.org_id,
      agentId: input.agent_id,
      accountId: input.account_id,
      accountAddress: input.account_address,
      kind: input.intent.kind,
      amount: BigInt(input.intent.amount),
      claimed: toCounterparty(input.intent.counterparty),
      contract: input.intent.counterparty.contract ?? null,
      mandateId: input.mandate_id,
      session,
      extra,
    });
    await store.recordCounterpartySeen(tx, input.agent_id, keys, now);
    const id = await recordDecision(tx, audit, base, decision, now, {
      intent: { kind: input.intent.kind, amount: input.intent.amount },
      counterparty: keys,
    });
    return toWire(decision, id);
  });
}

// ------------------------------------------------------------------ cosign

type Inspection = { ok: true; userOpHash: Hex; spend: VerifiedSpend } | { ok: false; hits: RuleHit[] };

/**
 * Pure checks on the raw operation: shape, chain, sender, signer path,
 * signing deadline, hash, and the decoded calls against the stated action.
 * `treasury` is the org's registered treasury (looked up only when the
 * request states a savings sweep).
 */
function inspectOperation(
  ctx: ServiceContext,
  input: CosignInternal,
  action: CosignAction,
  treasury: string | null,
  now: Date,
): Inspection {
  const deny = (rule: string, detail: string): Inspection => ({
    ok: false,
    hits: [hit(rule, "deny", detail)],
  });
  if (input.chain_id !== ctx.config.chainId) return { ok: false, hits: [chainHit(ctx, input.chain_id)] };
  const parsed = PreparedOperationSchema.safeParse(input.operation);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return deny("cosigner.operation", `The operation is malformed: ${issues}`);
  }
  const op = parsed.data as unknown as PreparedOperation;
  const contracts = ctx.chain.contracts;
  if (op.chainId !== ctx.config.chainId)
    return deny("cosigner.operation", `The operation is for chain ${op.chainId}`);
  if (!sameAddress(op.entryPoint, contracts.entryPoint)) {
    return deny("cosigner.operation", "The operation targets an unknown EntryPoint");
  }
  if (
    !sameAddress(op.account, input.account_address) ||
    !sameAddress(op.userOp.sender, input.account_address)
  ) {
    return deny("cosigner.operation", `The operation's sender is not account ${input.account_address}`);
  }
  if (op.signer !== "session") {
    return deny(
      "cosigner.operation",
      "Only session-path operations are co-signed; owner operations are signed by the owner alone",
    );
  }
  if (op.userOp.factory !== null)
    return deny("cosigner.operation", "Session operations never deploy the account");
  if (op.validUntil * 1000 < now.getTime()) {
    return deny(
      "cosigner.operation",
      `The operation's signing deadline passed at ${new Date(op.validUntil * 1000).toISOString()}`,
    );
  }
  let computed: Hex;
  try {
    computed = ctx.chain.hashOperation(op);
  } catch (error) {
    return deny("cosigner.operation", `The operation cannot be hashed: ${(error as Error).message}`);
  }
  if (computed.toLowerCase() !== input.user_op_hash.toLowerCase()) {
    return deny(
      "cosigner.user_op_hash",
      `user_op_hash ${input.user_op_hash} is not the hash of the operation (${computed})`,
    );
  }
  let calls: DecodedCall[];
  try {
    calls = ctx.chain.decodeOperation(op);
  } catch (error) {
    return deny("cosigner.operation", `The operation cannot be decoded: ${(error as Error).message}`);
  }
  const match = matchCalls(
    calls,
    {
      action,
      kind: input.intent.kind,
      amount: BigInt(input.intent.amount),
      fee: BigInt(input.fee),
      counterpartyAddress: input.intent.counterparty.address?.toLowerCase() ?? null,
      contract: input.intent.counterparty.contract ?? null,
      onchainId: input.onchain_id === undefined ? null : BigInt(input.onchain_id),
      savingsSweep: input.savings_sweep === undefined ? 0n : BigInt(input.savings_sweep),
    },
    {
      usdc: contracts.usdc,
      revenue: ctx.config.revenueAddress,
      escrow: contracts.escrow,
      streams: contracts.streams,
      vaults: contracts.vaults,
      treasury,
      maxFeeSweep: ctx.config.maxFeeSweep,
    },
  );
  if (!match.ok) {
    const prefix =
      match.rule === "cosigner.intent_mismatch" ? "The operation does not match the stated intent: " : "";
    return deny(match.rule, `${prefix}${match.reason}`);
  }
  return { ok: true, userOpHash: computed.toLowerCase() as Hex, spend: match.spend };
}

async function accountOfAgent(ctx: ServiceContext, tx: SqlClient, agentId: string): Promise<string | null> {
  const { rows } = await tx.query<{ address: string }>(
    "SELECT address FROM account_binding WHERE agent_id = $1 AND chain_id = $2 ORDER BY created_at LIMIT 1",
    [agentId, ctx.config.chainId],
  );
  return rows[0]?.address ?? null;
}

/**
 * Who the operation provably pays, for the policy engine: the decoded
 * recipient, and the agent the co-signer's own registry binds to it. The
 * API's other identifiers are passed as "claimed" and can only make the
 * decision stricter.
 */
async function counterparties(
  ctx: ServiceContext,
  tx: SqlClient,
  input: CosignInternal,
  spend: VerifiedSpend,
  extra: RuleHit[],
): Promise<{ claimed: IntentCounterparty; verified?: IntentCounterparty }> {
  const stated = toCounterparty(input.intent.counterparty);
  if (spend.recipient === null) {
    // stream.top_up: the payee is not in the calldata. PaymentStreams lets only the payer top up its own
    // streams, whose payee was checked when they were created.
    extra.push(
      hit(
        "cosigner.counterparty",
        "info",
        "The stream's payee is not in the calldata; only the payer can top up its own stream, whose payee was checked at creation",
      ),
    );
    return { claimed: stated };
  }
  const claimed: IntentCounterparty = { ...stated, address: spend.recipient };
  const payeeAccount = await store.getAccountByAddress(tx, ctx.config.chainId, spend.recipient);
  const verified: IntentCounterparty = { address: spend.recipient, agentId: payeeAccount?.agent_id ?? null };
  if (claimed.agentId) {
    const claimedAccount = await accountOfAgent(ctx, tx, claimed.agentId);
    if (claimedAccount && !sameAddress(claimedAccount, spend.recipient)) {
      extra.push(
        hit(
          "cosigner.counterparty",
          "deny",
          `Agent ${claimed.agentId}'s account is ${claimedAccount}, but the operation pays ${spend.recipient}`,
        ),
      );
    } else if (payeeAccount?.agent_id !== claimed.agentId) {
      extra.push(
        hit(
          "cosigner.counterparty",
          "info",
          `Agent ${claimed.agentId} is not bound to ${spend.recipient} in the co-signer's registry; it only counts for restrictive rules`,
        ),
      );
    }
  }
  return { claimed, verified };
}

/**
 * Co-sign an agent operation, or refuse. Nothing in the request is trusted on
 * its own: the hash is recomputed and the calls decoded from the raw
 * operation and matched against the stated action, the session key's
 * signature is verified, and payments are evaluated by the policy engine
 * against the co-signer's own state, serialized per agent. Actions that move
 * nothing out of the account (escrow release/refund/dispute, stream cancel)
 * need a valid, unfrozen session but no policy evaluation and count no spend.
 * `outcome === "allow"` if and only if a signature is returned.
 */
export async function cosign(ctx: ServiceContext, input: CosignInternal): Promise<CosignResultInternal> {
  assertIds({
    payment_id: input.payment_id,
    org_id: input.org_id,
    agent_id: input.agent_id,
    account_id: input.account_id,
    session_id: input.session_id,
    mandate_id: input.mandate_id,
    approval_id: input.approval?.approval_id,
  });
  const now = ctx.clock.now();
  const base: DecisionBase = {
    source: "cosign",
    paymentId: input.payment_id,
    orgId: input.org_id,
    agentId: input.agent_id,
  };
  const result = (decision: DecisionInternal, signature: Hex | null): CosignResultInternal => ({
    decision,
    signature,
    cosigner_address: ctx.signer.address,
  });
  if (ctx.config.failClosed) return result(await failClosed(ctx, base, now), null);

  const action = actionFor(input.intent.kind, input.action);
  if (action === null) {
    const detail =
      input.intent.kind === "x402"
        ? "x402 payments are authorized with /internal/v1/x402/authorize and signed by the spend key, never co-signed"
        : `action ${input.action ?? "(none)"} does not fit payment kind ${input.intent.kind}`;
    const decision = refusal([hit("cosigner.intent_mismatch", "deny", detail)], now);
    return result(await recordRefusal(ctx, base, decision, now, { user_op_hash: input.user_op_hash }), null);
  }
  // The treasury is looked up only when the request says the operation sweeps savings to it.
  const savingsStated = input.savings_sweep !== undefined && BigInt(input.savings_sweep) > 0n;
  const treasury = savingsStated ? ((await store.getTreasury(ctx.db, input.org_id))?.address ?? null) : null;
  const inspected = inspectOperation(ctx, input, action, treasury, now);
  if (!inspected.ok) {
    return result(
      await recordRefusal(ctx, base, refusal(inspected.hits, now), now, { user_op_hash: input.user_op_hash }),
      null,
    );
  }
  const { userOpHash, spend } = inspected;
  const requestHash = canonicalSha256(input);

  return transaction(ctx, async (tx, audit) => {
    const refuse = async (decision: FinalDecision) =>
      result(
        toWire(
          decision,
          await recordDecision(tx, audit, base, decision, now, { user_op_hash: userOpHash, action }),
        ),
        null,
      );

    // Serialize decisions per agent: concurrent payments cannot jointly pass a cap.
    await store.lockAgent(tx, input.agent_id);

    // One co-signature per payment; an identical retry gets the original answer.
    const prior = await store.getSpend(tx, input.payment_id);
    if (prior) {
      if (prior.request_hash === requestHash && prior.status !== "released" && prior.signature !== null) {
        const original = await originalDecision(tx, prior.decision_id);
        if (original) return result(original, prior.signature as Hex);
      }
      return refuse(
        refusal(
          [
            hit(
              "cosigner.payment_replay",
              "deny",
              `Payment ${input.payment_id} was already co-signed for another request`,
            ),
          ],
          now,
        ),
      );
    }
    const sameOp = await store.findSpendByUserOp(tx, userOpHash);
    if (sameOp) {
      return refuse(
        refusal(
          [
            hit(
              "cosigner.operation_replay",
              "deny",
              `Operation ${userOpHash} was already co-signed for payment ${sameOp.payment_id}`,
            ),
          ],
          now,
        ),
      );
    }

    // The session is registered for this very account, alive, and its key signed this very hash.
    const session = await store.getSession(tx, input.session_id);
    const sessionHits: RuleHit[] = [];
    const problem = sessionProblem(ctx, session, input);
    if (problem || !session) {
      sessionHits.push(hit("cosigner.session", "deny", problem ?? `Unknown session ${input.session_id}`));
    } else {
      if (session.revoked_at !== null && session.revoked_at.getTime() <= now.getTime()) {
        sessionHits.push(
          hit(
            "session.revoked",
            "deny",
            `The session key was revoked at ${session.revoked_at.toISOString()}`,
          ),
        );
      }
      if (session.expires_at.getTime() <= now.getTime()) {
        sessionHits.push(
          hit("session.expired", "deny", `The session key expired at ${session.expires_at.toISOString()}`),
        );
      }
      // EIP-191 over the raw 32-byte hash (core OPERATION_HASH_SIGNING), v normalized like the on-chain encoder.
      const signer = await recoverOperationSigner(userOpHash, input.session_signature as Hex).catch(
        () => null,
      );
      if (!sameAddress(signer, session.public_key)) {
        sessionHits.push(
          hit(
            "cosigner.session_signature",
            "deny",
            "The session signature does not recover to the session key",
          ),
        );
      }
    }
    if (sessionHits.length > 0) return refuse(refusal(sessionHits, now));
    const liveSession = session as store.SessionRow;

    const extra: RuleHit[] = [];
    let decision: FinalDecision;
    let keys: store.CounterpartyKeys = { address: null, agentId: null, erc8004Id: null, x402Domain: null };
    if (movesNothing(action)) {
      decision = await ctx.evaluator.assessNoOutflow(tx, {
        now,
        orgId: input.org_id,
        agentId: input.agent_id,
        accountId: input.account_id,
        accountAddress: input.account_address,
        session: liveSession,
        outflow: spend.outflow,
        action,
        contract: spend.contract as string,
        extra,
      });
    } else {
      const parties = await counterparties(ctx, tx, input, spend, extra);
      const evaluated = await ctx.evaluator.decide(tx, {
        now,
        orgId: input.org_id,
        agentId: input.agent_id,
        accountId: input.account_id,
        accountAddress: input.account_address,
        kind: input.intent.kind,
        amount: spend.amount,
        claimed: parties.claimed,
        ...(parties.verified ? { verified: parties.verified } : {}),
        contract: spend.contract,
        mandateId: input.mandate_id,
        session: liveSession,
        outflow: spend.outflow,
        extra,
      });
      keys = evaluated.keys;
      decision = applyApproval(evaluated.decision, input.approval);
      await store.recordCounterpartySeen(tx, input.agent_id, keys, now);
    }
    if (decision.outcome !== "allow") return refuse(decision);

    const signature = await ctx.signer.signHash(userOpHash);
    const decisionId = newId("decision", now.getTime());
    await store.insertDecision(tx, decisionRow(decisionId, base, decision));
    await store.insertSpend(tx, {
      payment_id: input.payment_id,
      source: "cosign",
      action,
      org_id: input.org_id,
      agent_id: input.agent_id,
      account_id: input.account_id,
      session_id: input.session_id,
      mandate_id: movesNothing(action) ? null : (input.mandate_id ?? null),
      kind: input.intent.kind,
      counterparty_address: keys.address,
      counterparty_agent_id: keys.agentId,
      counterparty_erc8004_id: keys.erc8004Id,
      counterparty_x402_domain: keys.x402Domain,
      amount: spend.amount,
      fee: BigInt(input.fee),
      savings: spend.savings,
      outflow: spend.outflow,
      request_hash: requestHash,
      user_op_hash: userOpHash,
      signature,
      decision_id: decisionId,
      reserved_at: now,
    });
    if (input.mandate_id && !movesNothing(action)) await store.refreshMandateUsage(tx, input.mandate_id);
    await audit({
      at: now,
      actor: "api",
      action: "cosign.signed",
      subject: input.payment_id,
      payload: {
        decision_id: decisionId,
        outcome: decision.outcome,
        policy_version: decision.policyVersion,
        org_id: input.org_id,
        agent_id: input.agent_id,
        account_id: input.account_id,
        session_id: input.session_id,
        mandate_id: input.mandate_id ?? null,
        kind: input.intent.kind,
        action,
        onchain_id: input.onchain_id ?? null,
        recipient: spend.recipient,
        contract: spend.contract,
        amount: spend.amount.toString(),
        fee: input.fee,
        savings_sweep: spend.savings.toString(),
        treasury,
        outflow: spend.outflow.toString(),
        user_op_hash: userOpHash,
        approval: input.approval ?? null,
        cosigner_address: ctx.signer.address,
        signature,
      },
    });
    return result(toWire(decision, decisionId), signature);
  });
}

// ------------------------------------------------------------------ x402

/**
 * x402 (ADR 0001): the agent's spend key signs the EIP-3009 authorization,
 * so there is nothing to co-sign; the same policy is evaluated (domain
 * allowlist, caps, velocity, mandate) and the spend reserved.
 */
export async function authorizeX402(
  ctx: ServiceContext,
  input: AuthorizeX402Internal,
): Promise<{ decision: DecisionInternal }> {
  assertIds({
    payment_id: input.payment_id,
    org_id: input.org_id,
    agent_id: input.agent_id,
    account_id: input.account_id,
    mandate_id: input.mandate_id,
  });
  const now = ctx.clock.now();
  const base: DecisionBase = {
    source: "x402",
    paymentId: input.payment_id,
    orgId: input.org_id,
    agentId: input.agent_id,
  };
  if (ctx.config.failClosed) return { decision: await failClosed(ctx, base, now) };
  if (input.chain_id !== ctx.config.chainId) {
    return {
      decision: await recordRefusal(ctx, base, refusal([chainHit(ctx, input.chain_id)], now), now, {}),
    };
  }
  const requestHash = canonicalSha256(input);
  return transaction(ctx, async (tx, audit) => {
    await store.lockAgent(tx, input.agent_id);
    const prior = await store.getSpend(tx, input.payment_id);
    if (prior) {
      if (prior.request_hash === requestHash && prior.status !== "released") {
        const original = await originalDecision(tx, prior.decision_id);
        if (original) return { decision: original };
      }
      const decision = refusal(
        [
          hit(
            "cosigner.payment_replay",
            "deny",
            `Payment ${input.payment_id} was already authorized for another request`,
          ),
        ],
        now,
      );
      return { decision: toWire(decision, await recordDecision(tx, audit, base, decision, now, {})) };
    }
    const extra: RuleHit[] = [];
    // The spend key is pinned on first sight; refills may only ever go to it.
    const pinned = await store.bindSpendKey(tx, input.account_id, input.spend_key_address, now);
    if (!sameAddress(pinned, input.spend_key_address)) {
      extra.push(
        hit(
          "cosigner.spend_key",
          "deny",
          `The account's registered spend key is ${pinned}, not ${input.spend_key_address}`,
        ),
      );
    }
    const amount = BigInt(input.amount);
    const { decision, keys } = await ctx.evaluator.decide(tx, {
      now,
      orgId: input.org_id,
      agentId: input.agent_id,
      accountId: input.account_id,
      accountAddress: input.account_address,
      kind: "x402",
      amount,
      claimed: { address: input.pay_to, x402Domain: input.x402_domain },
      mandateId: input.mandate_id,
      session: null,
      extra,
    });
    await store.recordCounterpartySeen(tx, input.agent_id, keys, now);
    if (decision.outcome !== "allow") {
      const id = await recordDecision(tx, audit, base, decision, now, {
        x402_domain: input.x402_domain,
        pay_to: input.pay_to,
      });
      return { decision: toWire(decision, id) };
    }
    const decisionId = newId("decision", now.getTime());
    await store.insertDecision(tx, decisionRow(decisionId, base, decision));
    await store.insertSpend(tx, {
      payment_id: input.payment_id,
      source: "x402",
      action: "x402",
      org_id: input.org_id,
      agent_id: input.agent_id,
      account_id: input.account_id,
      session_id: null,
      mandate_id: input.mandate_id ?? null,
      kind: "x402",
      counterparty_address: keys.address,
      counterparty_agent_id: null,
      counterparty_erc8004_id: null,
      counterparty_x402_domain: keys.x402Domain,
      amount,
      fee: 0n,
      savings: 0n,
      outflow: amount,
      request_hash: requestHash,
      user_op_hash: null,
      signature: null,
      decision_id: decisionId,
      reserved_at: now,
    });
    if (input.mandate_id) await store.refreshMandateUsage(tx, input.mandate_id);
    await audit({
      at: now,
      actor: "api",
      action: "x402.authorized",
      subject: input.payment_id,
      payload: {
        decision_id: decisionId,
        policy_version: decision.policyVersion,
        org_id: input.org_id,
        agent_id: input.agent_id,
        account_id: input.account_id,
        mandate_id: input.mandate_id ?? null,
        x402_domain: input.x402_domain,
        pay_to: getAddress(input.pay_to),
        spend_key: getAddress(input.spend_key_address),
        amount: input.amount,
      },
    });
    return { decision: toWire(decision, decisionId) };
  });
}

// ------------------------------------------------------------------ settlements

/**
 * Mark reserved spend settled (optionally for a smaller amount) or released
 * (failed or expired). Released spend stops counting against caps; a late
 * settlement of released spend counts it again. Settled spend is never
 * released. Unknown payments are recorded in the audit log and ignored.
 */
export async function reportSettlement(ctx: ServiceContext, input: SettlementReportInternal): Promise<void> {
  assertIds({ payment_id: input.payment_id });
  const now = ctx.clock.now();
  await transaction(ctx, async (tx, audit) => {
    const found = await store.getSpend(tx, input.payment_id);
    if (!found) {
      await audit({
        at: now,
        actor: "api",
        action: "settlement.unknown_payment",
        subject: input.payment_id,
        payload: { status: input.status, amount: input.amount ?? null },
      });
      return;
    }
    await store.lockAgent(tx, found.agent_id);
    const spend = (await store.getSpend(tx, input.payment_id, true)) as store.SpendRow;
    const amount = input.amount === undefined ? null : BigInt(input.amount);
    let next: store.SpendStatus;
    if (input.status === "settled") {
      if (amount !== null && amount > spend.amount) {
        throw new AgentBankError(
          "invalid_request",
          `Settled amount ${amount} exceeds the authorized ${spend.amount}`,
        );
      }
      const settledAmount = amount !== null && amount < spend.amount ? amount : null;
      if (spend.status === "settled") {
        if ((spend.settled_amount ?? spend.amount) === (settledAmount ?? spend.amount)) return;
        throw new AgentBankError(
          "conflict",
          `Payment ${input.payment_id} already settled for another amount`,
        );
      }
      await store.settleSpend(tx, input.payment_id, settledAmount, now);
      next = "settled";
    } else {
      if (spend.status === "released") return;
      if (spend.status === "settled") {
        throw new AgentBankError(
          "invalid_state",
          `Payment ${input.payment_id} settled; its spend cannot be released`,
        );
      }
      await store.releaseSpend(tx, input.payment_id, now);
      next = "released";
    }
    if (spend.mandate_id) await store.refreshMandateUsage(tx, spend.mandate_id);
    await audit({
      at: now,
      actor: "api",
      action: next === "settled" ? "spend.settled" : "spend.released",
      subject: input.payment_id,
      payload: {
        agent_id: spend.agent_id,
        from: spend.status,
        to: next,
        amount: spend.amount.toString(),
        settled_amount: next === "settled" ? (amount ?? spend.amount).toString() : null,
      },
    });
  });
}
