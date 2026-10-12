import type { PaymentKind, PolicyDocument, RuleHit } from "@agentbank/core";
import type { SqlClient } from "@agentbank/db";
import {
  compileMandate,
  compilePolicy,
  compileSessionScope,
  evaluate,
  normalizeAddress,
  normalizeAgentId,
  normalizeDomain,
  normalizeErc8004Id,
  type CompiledMandate,
  type CompiledPolicy,
  type CompiledSessionScope,
  type EvaluationContext,
  type IntentCounterparty,
  type MandateContext,
  type SessionContext,
} from "@agentbank/policy";
import { hit, merge, outcomeOf, stricter, type FinalDecision } from "./decision";
import * as store from "./store";

const CACHE_LIMIT = 10_000;

function remember<K, V>(cache: Map<K, V>, key: K, value: V): V {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
  return value;
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/** Normalized identifiers of every description of the counterparty given. */
export function counterpartyKeys(...cps: (IntentCounterparty | undefined)[]): store.CounterpartyKeys {
  const keys: store.CounterpartyKeys = { address: null, agentId: null, erc8004Id: null, x402Domain: null };
  for (const cp of cps) {
    if (!cp) continue;
    keys.address ??= normalizeAddress(cp.address);
    keys.agentId ??= normalizeAgentId(cp.agentId);
    keys.erc8004Id ??= normalizeErc8004Id(cp.erc8004Id);
    keys.x402Domain ??= normalizeDomain(cp.x402Domain);
  }
  return keys;
}

/** A decision made from the co-signer's own hits alone (no policy evaluation). */
function refusalOr(hits: RuleHit[], now: Date, policyVersion: number): FinalDecision {
  return {
    outcome: outcomeOf(hits),
    ruleHits: hits,
    approversRequired: 0,
    policyVersion,
    evaluatedAt: now,
    retryAt: null,
  };
}

export interface DecideArgs {
  now: Date;
  orgId: string;
  agentId: string;
  accountId: string;
  accountAddress: string;
  kind: PaymentKind;
  amount: bigint;
  /** The counterparty as the API describes it. */
  claimed: IntentCounterparty;
  /**
   * Co-signing only: the identifiers the co-signer established itself (the
   * payee address decoded from the operation, and the agent its own registry
   * binds to that address).
   */
  verified?: IntentCounterparty;
  /** Escrow or streams contract the payment goes through. */
  contract?: string | null;
  mandateId?: string | undefined;
  session: store.SessionRow | null;
  /** Co-signing only: everything the operation moves out (amount, fee, sweeps). */
  outflow?: bigint;
  /** The co-signer's own hits gathered so far; more are added here. */
  extra: RuleHit[];
}

/**
 * Builds evaluation contexts from the co-signer's own database (policy and
 * mandate copies, freezes, rolling spend windows, velocity counts,
 * counterparty first sight, session spend) and runs the deterministic policy
 * engine. Compiled policies, mandates and scopes are immutable per version,
 * so they are cached.
 */
export class PolicyEvaluator {
  readonly #chainId: number;
  readonly #policies = new Map<string, CompiledPolicy>();
  readonly #mandates = new Map<string, CompiledMandate>();
  readonly #scopes = new Map<string, CompiledSessionScope>();

  constructor(chainId: number) {
    this.#chainId = chainId;
  }

  /**
   * Evaluate the intent. With `verified` identifiers (co-signing) it is
   * evaluated twice, with the verified identifiers and with everything the
   * API claimed, and the stricter decision wins: identifiers the co-signer
   * cannot verify can make a decision stricter (denylists, caps, cooling
   * periods), never looser (allowlists, mandate payees).
   */
  async decide(
    tx: SqlClient,
    args: DecideArgs,
  ): Promise<{ decision: FinalDecision; keys: store.CounterpartyKeys }> {
    const { now, extra } = args;
    await this.#checkBindings(tx, args);
    const policy = await this.#policy(tx, args.agentId, now, extra);

    const targets: { scope: store.FreezeScope; id: string }[] = [
      { scope: "org", id: args.orgId },
      { scope: "agent", id: args.agentId },
    ];
    if (args.session) targets.push({ scope: "session", id: args.session.id });
    const frozen = await store.frozenTargets(tx, targets, now);
    if (args.session && frozen.has(`session:${args.session.id}`)) {
      extra.push(hit("cosigner.session_frozen", "deny", `Session ${args.session.id} is frozen`));
    }

    const mandate = await this.#mandate(tx, args, extra);
    const session = await this.#session(tx, args, extra);

    const keys = counterpartyKeys(args.claimed, args.verified);
    const windows = await store.spendWindows(tx, args.agentId, now, keys);
    const firstSeen = await store.counterpartyFirstSeen(tx, args.agentId, keys);
    const spendKey = await store.getSpendKey(tx, args.accountId);
    const context = (counterparty: IntentCounterparty): EvaluationContext => ({
      now,
      agent: {
        id: args.agentId,
        status: frozen.has(`agent:${args.agentId}`) ? "frozen" : "active",
        spendKeyAddress: spendKey,
      },
      org: { status: frozen.has(`org:${args.orgId}`) ? "frozen" : "active" },
      intent: {
        kind: args.kind,
        amount: args.amount,
        asset: "USDC",
        counterparty,
        contract: args.contract ?? null,
      },
      history: { ...windows, counterpartyFirstSeenAt: firstSeen },
      mandate,
      session,
    });
    let decision = evaluate(policy, context(args.verified ?? args.claimed));
    if (args.verified) decision = stricter(decision, evaluate(policy, context(args.claimed)));
    return { decision: merge(decision, extra, now), keys };
  }

  /**
   * For actions that move nothing out of the account (escrow release, refund,
   * dispute; stream cancel) there is no payment for the policy engine to
   * evaluate. They are still refused when the org, agent or session is
   * frozen, when the account bindings disagree, when the session may not call
   * the contract, or when attached fees and sweeps exceed the session's caps.
   */
  async assessNoOutflow(
    tx: SqlClient,
    args: Pick<
      DecideArgs,
      "now" | "orgId" | "agentId" | "accountId" | "accountAddress" | "session" | "outflow" | "extra"
    > & {
      action: string;
      contract: string;
    },
  ): Promise<FinalDecision> {
    const { now, extra } = args;
    await this.#checkBindings(tx, args);
    const targets: { scope: store.FreezeScope; id: string }[] = [
      { scope: "org", id: args.orgId },
      { scope: "agent", id: args.agentId },
    ];
    if (args.session) targets.push({ scope: "session", id: args.session.id });
    const frozen = await store.frozenTargets(tx, targets, now);
    if (frozen.has(`org:${args.orgId}`))
      extra.push(hit("org.frozen", "deny", "The organization is frozen; nothing is co-signed"));
    if (frozen.has(`agent:${args.agentId}`))
      extra.push(hit("agent.frozen", "deny", `Agent ${args.agentId} is frozen; nothing is co-signed`));
    if (args.session && frozen.has(`session:${args.session.id}`)) {
      extra.push(hit("cosigner.session_frozen", "deny", `Session ${args.session.id} is frozen`));
    }
    const session = await this.#session(
      tx,
      { now, session: args.session, outflow: args.outflow ?? 0n },
      extra,
    );
    if (session?.scope.allowedContracts && !session.scope.allowedContracts.has(args.contract.toLowerCase())) {
      extra.push(
        hit(
          "session.allowed_contracts",
          "deny",
          `${args.contract} is not an allowed contract of the session`,
        ),
      );
    }
    extra.push(
      hit(
        "cosigner.no_outflow",
        "allow",
        `${args.action} moves no funds out of the account; the contract decides who may call it and where funds go`,
      ),
    );
    const policy = await store.currentPolicy(tx, args.agentId, now);
    return refusalOr(extra, now, policy?.version ?? 0);
  }

  async #checkBindings(
    tx: SqlClient,
    args: Pick<DecideArgs, "orgId" | "agentId" | "accountId" | "accountAddress" | "extra">,
  ): Promise<void> {
    const agentOrg = await store.getAgentOrg(tx, args.agentId);
    if (agentOrg !== null && agentOrg !== args.orgId) {
      args.extra.push(hit("cosigner.binding", "deny", `Agent ${args.agentId} belongs to another org`));
    }
    const account = await store.getAccount(tx, args.accountId);
    if (
      account &&
      (account.agent_id !== args.agentId ||
        account.chain_id !== this.#chainId ||
        !sameAddress(account.address, args.accountAddress))
    ) {
      args.extra.push(
        hit(
          "cosigner.binding",
          "deny",
          `Account ${args.accountId} is registered to another agent or address`,
        ),
      );
    }
    const byAddress = await store.getAccountByAddress(tx, this.#chainId, args.accountAddress);
    if (byAddress && byAddress.account_id !== args.accountId) {
      args.extra.push(
        hit(
          "cosigner.binding",
          "deny",
          `Address ${args.accountAddress} is registered as account ${byAddress.account_id}`,
        ),
      );
    }
  }

  async #policy(tx: SqlClient, agentId: string, now: Date, extra: RuleHit[]): Promise<CompiledPolicy | null> {
    const row = await store.currentPolicy(tx, agentId, now);
    if (!row) return null;
    const key = `${agentId}:${row.version}:${row.policy_hash}`;
    try {
      return (
        this.#policies.get(key) ??
        remember(this.#policies, key, compilePolicy(row.document as PolicyDocument, row.version))
      );
    } catch (error) {
      extra.push(
        hit(
          "cosigner.policy",
          "deny",
          `Stored policy version ${row.version} does not compile: ${(error as Error).message}`,
        ),
      );
      return null;
    }
  }

  async #mandate(tx: SqlClient, args: DecideArgs, extra: RuleHit[]): Promise<MandateContext | null> {
    if (args.mandateId === undefined) return null;
    const row = await store.getMandate(tx, args.mandateId);
    if (!row) {
      extra.push(hit("cosigner.mandate", "deny", `Unknown mandate ${args.mandateId}`));
      return null;
    }
    if (row.agent_id !== args.agentId) {
      extra.push(hit("cosigner.mandate", "deny", `Mandate ${args.mandateId} belongs to another agent`));
      return null;
    }
    if (row.revoked_at !== null && row.revoked_at.getTime() <= args.now.getTime()) {
      extra.push(
        hit(
          "cosigner.mandate",
          "deny",
          `Mandate ${args.mandateId} was revoked at ${row.revoked_at.toISOString()}`,
        ),
      );
      return null;
    }
    const key = `${row.id}:${row.mandate_hash}`;
    try {
      const compiled =
        this.#mandates.get(key) ??
        remember(this.#mandates, key, compileMandate(row.document as Parameters<typeof compileMandate>[0]));
      return {
        mandate: compiled,
        spent: row.spent,
        occurrences: row.occurrences,
        lastOccurrenceAt: row.last_occurrence_at,
      };
    } catch (error) {
      extra.push(
        hit(
          "cosigner.mandate",
          "deny",
          `Mandate ${args.mandateId} does not compile: ${(error as Error).message}`,
        ),
      );
      return null;
    }
  }

  async #session(
    tx: SqlClient,
    args: Pick<DecideArgs, "now" | "session" | "outflow">,
    extra: RuleHit[],
  ): Promise<SessionContext | null> {
    const s = args.session;
    if (!s) return null;
    const scope = this.#scopes.get(s.id) ?? remember(this.#scopes, s.id, compileSessionScope(s.scope));
    const spentToday = await store.sessionOutflowLastDay(tx, s.id, args.now);
    if (args.outflow !== undefined) {
      // On-chain, the policy hook caps each operation's total token outflow, fees included.
      if (args.outflow > scope.maxPerTx) {
        extra.push(
          hit(
            "cosigner.session_outflow",
            "deny",
            `The operation moves ${args.outflow} in total (fees included), above the session's max_per_tx of ${scope.maxPerTx}`,
          ),
        );
      }
      if (spentToday + args.outflow > scope.maxPerDay) {
        extra.push(
          hit(
            "cosigner.session_outflow",
            "deny",
            `${args.outflow} + ${spentToday} already moved by the session in 24 h exceeds its max_per_day of ${scope.maxPerDay}`,
          ),
        );
      }
    }
    return { scope, spentToday, revokedAt: s.revoked_at };
  }
}
