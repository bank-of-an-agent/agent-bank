import {
  approveCall,
  encodeSessionSignature,
  signOperationHash,
  transferCall,
  type Call,
} from "@agentbank/chain";
import { PolicyDeniedError, transferWithAuthorizationTypedData } from "@agentbank/sdk";
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { onboardAgent, randomAccount, type AgentWorld } from "./actors";
import type { Stack } from "./stack";

/**
 * A scripted adversary modelling the worst case of the threat model: a prompt-injected agent
 * that fully controls its own runtime, session key and spend key (strictly stronger than an LLM
 * tricked through its tools). It attacks the real stack over HTTP (and the chain directly) and
 * records every attempt. Nothing it does may exceed a limit or move smart-account funds to a
 * non-allowlisted address on-chain; the only funds it can move outside policy are the spend-key
 * float (ADR 0001), and the loss is asserted to be bounded by that float.
 */

export interface Attempt {
  category: string;
  /** `refused` (policy/protocol/chain said no), `drained` (bounded float loss), `leaked` (a violation!). */
  outcome: "refused" | "drained" | "leaked";
  /** The rule id or error code behind a refusal (always set for a refusal). */
  ruleId: string | null;
  detail?: string;
}

export interface RedTeamReport {
  attempts: Attempt[];
  total: number;
  byCategory: Record<string, number>;
  refusalsByRule: Record<string, number>;
  leaks: Attempt[];
  floatMinor: bigint;
  maxLossMinor: bigint;
  /** Smart-account (operating) USDC that reached any attacker address on-chain (must be 0). */
  smartAccountLeakMinor: bigint;
  attackerGainMinor: bigint;
}

const USDC_DOMAIN = { name: "USDC", version: "2" };

function ruleOfDenied(error: PolicyDeniedError): string {
  const deny = error.decision?.rule_hits?.find((h) => h.effect === "deny" || h.effect === "require_owner");
  return deny?.rule ?? error.decision?.rule_hits?.[0]?.rule ?? error.code ?? "policy_denied";
}

/** Interpret a thrown error as a refusal with a rule id (policy rule or protocol error code). */
function refusal(category: string, error: unknown): Attempt {
  if (error instanceof PolicyDeniedError) {
    return { category, outcome: "refused", ruleId: ruleOfDenied(error) };
  }
  const code = (error as { code?: string } | null)?.code;
  const reason = (error as { extensions?: { reason?: string } } | null)?.extensions?.reason;
  const message = error instanceof Error ? error.message : String(error);
  return { category, outcome: "refused", ruleId: code ?? "error", detail: reason ?? message.slice(0, 120) };
}

export class Adversary {
  readonly attempts: Attempt[] = [];
  /** Addresses that must never receive smart-account funds (attackers, lookalikes, other orgs). */
  readonly attackers: Address[] = [];
  /** Where the float drain lands (the one bounded leak). */
  readonly drainSink: PrivateKeyAccount = randomAccount();

  constructor(
    private readonly stack: Stack,
    readonly victim: AgentWorld,
    /** The one allowlisted payee (policy + session allow it). */
    readonly allowedPayee: Address,
    readonly cosignerAddress: Address,
    readonly floatMinor: bigint,
  ) {
    this.attackers.push(this.drainSink.address);
  }

  private record(a: Attempt): Attempt {
    this.attempts.push(a);
    return a;
  }

  private attacker(i: number): Address {
    // A mix of random attackers and look-alikes of the allowed payee (last nibble flipped).
    if (i % 3 === 0) {
      const flipped = `0x${this.allowedPayee.slice(2, -1)}${this.allowedPayee.slice(-1) === "0" ? "1" : "0"}`;
      const a = getAddress(flipped) as Address;
      if (!this.attackers.includes(a)) this.attackers.push(a);
      return a;
    }
    const a = randomAccount().address;
    this.attackers.push(a);
    return a;
  }

  /**
   * A payment the SDK sends (the co-signer evaluates it), expected to be denied. `victim`
   * defaults to the main victim; pass another to attack a differently-configured agent (caps,
   * mandate, velocity). Returns the recorded attempt.
   */
  async deny(
    category: string,
    body: Parameters<AgentWorld["agent"]["pay"]>[0],
    victim: AgentWorld = this.victim,
  ): Promise<Attempt> {
    try {
      const payment = await victim.agent.pay(body, { idempotencyKey: `rt-${category}-${Math.random()}` });
      if (payment.status === "denied") {
        const hit = payment.decision?.rule_hits?.find((h) => h.effect === "deny");
        return this.record({ category, outcome: "refused", ruleId: hit?.rule ?? "policy_denied" });
      }
      // Anything that is not an outright denial must still never settle to an attacker.
      return this.record({ category, outcome: "leaked", ruleId: null, detail: `status ${payment.status}` });
    } catch (error) {
      return this.record(refusal(category, error));
    }
  }

  // ---------------------------------------------------------------- categories

  /** Amounts over a single window cap, on a victim configured with only that cap. */
  async overCap(victim: AgentWorld, amountOverCap: string, count: number): Promise<void> {
    const sink = this.attacker(0);
    for (let i = 0; i < count; i++) {
      await this.deny("amount_over_cap", { to: sink, amount: amountOverCap }, victim);
    }
  }

  /** Split a large spend into many small payments to a non-allowlisted payee. */
  async splitPayments(count: number): Promise<void> {
    const sink = this.attacker(7);
    for (let i = 0; i < count; i++) {
      await this.deny("split_payment", { to: sink, amount: "5.00" });
    }
  }

  /** Non-allowlisted payees: random, look-alikes, and another org's agent account. */
  async nonAllowlisted(count: number, otherOrgAgent: Address): Promise<void> {
    for (let i = 0; i < count; i++) {
      const to = i % 5 === 0 ? otherOrgAgent : this.attacker(i);
      await this.deny("non_allowlisted_payee", { to, amount: "1.00" });
    }
  }

  /**
   * Mandate budget overruns: the mandate victim has an open policy and a small mandate budget;
   * after warming up to the budget, every further payment under the mandate is denied.
   */
  async mandateOverrun(victim: AgentWorld, mandateId: string, sink: Address, count: number): Promise<void> {
    // Warm up to (not past) the $20 budget with two $9 payments (not recorded as attempts).
    for (const amount of ["9.00", "9.00"]) {
      await victim.agent
        .pay(
          { to: sink, amount, mandateId },
          { idempotencyKey: `rt-mandate-warmup-${amount}-${Math.random()}` },
        )
        .catch(() => undefined);
    }
    for (let i = 0; i < count; i++) {
      await this.deny("mandate_overrun", { to: sink, amount: "9.00", mandateId }, victim);
    }
  }

  /** Velocity: on a victim with max_per_minute = 3, burst past it. */
  async velocityBurst(victim: AgentWorld, sink: Address, count: number): Promise<void> {
    // Fill the per-minute window with 3 legitimate payments (not recorded).
    for (let i = 0; i < 3; i++) {
      await victim.agent
        .pay({ to: sink, amount: "0.50" }, { idempotencyKey: `rt-vel-warmup-${i}-${Math.random()}` })
        .catch(() => undefined);
    }
    for (let i = 0; i < count; i++) {
      await this.deny("velocity_burst", { to: sink, amount: "0.50" }, victim);
    }
  }

  /** x402 authorizations above caps, to other domains, and to malformed hosts. */
  async x402Abuse(count: number): Promise<void> {
    const hosts = [
      "not-allowed.example", // non-allowlisted domain
      "192.168.0.1", // IP, not a host name
      "allowed.example.", // trailing dot
      "allowed‮.example", // unicode trick
    ];
    for (let i = 0; i < count; i++) {
      const host = hosts[i % hosts.length] as string;
      const amount = i % 2 === 0 ? "0.01" : "9.99";
      try {
        const res = await this.victim.agent.x402.pay({
          account_id: this.victim.accountId,
          resource: { url: `https://${host}/data` },
          requirements: {
            scheme: "exact",
            network: `eip155:${this.stack.chainId}`,
            asset: getAddress(this.stack.sim.contracts.usdc),
            amount: String(BigInt(Math.round(Number(amount) * 1e6))),
            payTo: this.attacker(i),
            maxTimeoutSeconds: 120,
            extra: USDC_DOMAIN,
          },
        });
        const status = res.payment.status;
        if (status === "denied" || status === "requires_approval") {
          const hit = res.payment.decision?.rule_hits?.find((h) => h.effect !== "allow");
          this.record({ category: "x402_abuse", outcome: "refused", ruleId: hit?.rule ?? "policy_denied" });
        } else {
          this.record({
            category: "x402_abuse",
            outcome: "leaked",
            ruleId: null,
            detail: `status ${status}`,
          });
        }
      } catch (error) {
        this.record(refusal("x402_abuse", error));
      }
    }
  }

  /** Refills to a non-spend-key address, and refills above the per-tx cap to the real spend key. */
  async illegitRefill(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const toAttacker = i % 2 === 0;
      const to = toAttacker ? this.attacker(i) : this.victim.spendKeyAddress;
      const amount = toAttacker ? "5.00" : "1001.00"; // wrong target, or over the per-tx cap (1000)
      await this.deny("illegit_refill", { to, amount });
    }
  }

  /** Reuse an idempotency key with an altered body (different amount and recipient). */
  async replayAndIdempotency(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const key = `rt-idem-${i}-${Date.now()}-${Math.random()}`;
      // Establish the key with a (denied) payment to a non-allowlisted address.
      await this.victim.agent
        .pay({ to: this.attacker(i), amount: "9.00" }, { idempotencyKey: key })
        .catch(() => undefined);
      try {
        // Reuse the same key with a different body: the API must refuse (idempotency conflict),
        // never apply the new body.
        const replay = await this.victim.agent.pay(
          { to: this.attacker(i + 1), amount: "2.00" },
          { idempotencyKey: key },
        );
        // If it did not conflict, it must have returned the original (denied) payment, not paid.
        this.record({
          category: "idempotency_reuse",
          outcome: replay.status === "denied" || replay.status === "expired" ? "refused" : "leaked",
          ruleId: replay.status === "denied" ? "idempotency_consistent" : null,
          detail: `status ${replay.status}`,
        });
      } catch (error) {
        this.record(refusal("idempotency_reuse", error));
      }
    }
  }

  /** Forge a payment signature from a key that is not the victim's session key. */
  async forgedSignature(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      try {
        const created = await this.victim.agent.payments.create(
          {
            account_id: this.victim.accountId,
            amount: { amount: "1.00", asset: "USDC" },
            to: { address: this.allowedPayee },
          },
          { idempotencyKey: `rt-forge-${i}-${Math.random()}` },
        );
        if (created.status !== "requires_signature" || !created.signing_request) {
          this.record({ category: "forged_signature", outcome: "refused", ruleId: created.status });
          continue;
        }
        const attackerKey = privateKeyToAccount(generatePrivateKey());
        const signature = await signOperationHash(attackerKey, created.signing_request.user_op_hash as Hex);
        await this.victim.agent.payments.submitSignature(created.id, {
          session_id: this.victim.sessionId,
          signature,
        });
        this.record({ category: "forged_signature", outcome: "leaked", ruleId: null });
      } catch (error) {
        this.record(refusal("forged_signature", error));
      }
    }
  }

  /** Use an expired or revoked session to pay. */
  async deadSession(count: number, dead: { sessionId: string; key: PrivateKeyAccount }): Promise<void> {
    const { AgentClient } = await import("@agentbank/sdk");
    const client = new AgentClient({
      baseUrl: this.stack.apiUrl,
      accountId: this.victim.accountId,
      session: { id: dead.sessionId, signer: dead.key },
    });
    for (let i = 0; i < count; i++) {
      try {
        await client.payments.create(
          {
            account_id: this.victim.accountId,
            amount: { amount: "1.00", asset: "USDC" },
            to: { address: this.allowedPayee },
          },
          { idempotencyKey: `rt-dead-${i}-${Math.random()}` },
        );
        this.record({ category: "dead_session", outcome: "leaked", ruleId: null });
      } catch (error) {
        this.record(refusal("dead_session", error));
      }
    }
  }

  /**
   * Build operations with the session key and submit them straight to the chain, bypassing the
   * co-signer: arbitrary recipients, extra calls, an approval to the attacker, or calls to the
   * policy hook / validator. Without the co-signer's second signature the 2-of-2 fails; the hook
   * and session action policies reject the rest. No funds may move.
   */
  async directChain(count: number): Promise<void> {
    const c = this.stack.sim.contracts;
    const token = getAddress(c.usdc);
    const permissionId = this.permissionId();
    const callsFor = (i: number): Call[] => {
      switch (i % 5) {
        case 0:
          return [transferCall({ token, to: this.attacker(i), amount: this.floatMinor + 1_000_000n })];
        case 1:
          return [
            transferCall({ token, to: this.allowedPayee, amount: 1_000_000n }),
            transferCall({ token, to: this.attacker(i), amount: 1_000_000n }),
          ];
        case 2:
          return [approveCall({ token, spender: this.attacker(i), amount: 2n ** 256n - 1n })];
        case 3:
          return [{ to: getAddress(c.policyHook as Address), value: 0n, data: "0x" as Hex }];
        default:
          return [{ to: getAddress(c.ownableValidator), value: 0n, data: "0x" as Hex }];
      }
    };
    for (let i = 0; i < count; i++) {
      try {
        const prepared = await this.stack.sim.gateway.prepareOperation({
          account: getAddress(this.victim.accountAddress),
          session: { permissionId },
          calls: callsFor(i),
        });
        // A fake "co-signer" signature: the adversary does not have the real co-signer key.
        const fakeCosigner = privateKeyToAccount(generatePrivateKey());
        const signature = encodeSessionSignature({
          permissionId,
          sessionSignature: await signOperationHash(this.victim.sessionKey, prepared.userOpHash),
          cosignerSignature: await signOperationHash(fakeCosigner, prepared.userOpHash),
        });
        const { userOpHash } = await this.stack.sim.gateway.submitOperation({ op: prepared, signature });
        const receipt = await this.stack.sim.gateway.getOperationReceipt(userOpHash);
        this.record({
          category: "direct_chain_submit",
          outcome: receipt.status === "succeeded" ? "leaked" : "refused",
          ruleId: receipt.status === "succeeded" ? null : `chain.${receipt.status}`,
          detail: receipt.revertReason ?? undefined,
        });
      } catch (error) {
        this.record(refusal("direct_chain_submit", error));
      }
    }
  }

  /**
   * An EIP-3009 authorization claiming `from` = the smart account, "signed" through the session
   * (ADR 0001: agent sessions have no ERC-1271 rights), settled via the facilitator. Must fail,
   * so no smart-account funds leave through the x402 path.
   */
  async erc1271ViaAccount(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const now = this.stack.clock.nowSeconds();
      const authorization = {
        from: getAddress(this.victim.accountAddress),
        to: this.attacker(i),
        value: "1000000",
        validAfter: String(now - 60),
        validBefore: String(now + 600),
        nonce: keccak256(stringToHex(`rt-1271-${i}-${Math.random()}`)),
      };
      // The session key "signs" on behalf of the account (it cannot: USDC asks the account's ERC-1271).
      const signature = await this.victim.sessionKey.signTypedData(
        transferWithAuthorizationTypedData(
          { ...USDC_DOMAIN, chainId: this.stack.chainId, verifyingContract: this.stack.sim.contracts.usdc },
          authorization,
        ),
      );
      const outcome = await this.settleViaFacilitator(authorization, signature);
      this.record({
        category: "erc1271_via_account",
        outcome: outcome.success ? "leaked" : "refused",
        ruleId: outcome.success ? null : (outcome.reason ?? "facilitator_rejected"),
      });
    }
  }

  /** POST a crafted authorization to the facilitator's /settle. Returns whether it settled. */
  private async settleViaFacilitator(
    authorization: Record<string, string>,
    signature: Hex,
  ): Promise<{ success: boolean; reason?: string; transaction?: string }> {
    const requirements = {
      scheme: "exact",
      network: `eip155:${this.stack.chainId}`,
      asset: getAddress(this.stack.sim.contracts.usdc),
      amount: authorization.value,
      payTo: getAddress(authorization.to as string),
      maxTimeoutSeconds: 600,
      extra: USDC_DOMAIN,
    };
    const body = {
      x402Version: 2,
      paymentPayload: { x402Version: 2, accepted: requirements, payload: { signature, authorization } },
      paymentRequirements: requirements,
    };
    const res = await fetch(`${this.stack.facilitatorUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { success?: boolean; errorReason?: string; transaction?: string };
    return {
      success: json.success === true,
      ...(json.errorReason ? { reason: json.errorReason } : {}),
      ...(json.transaction ? { transaction: json.transaction } : {}),
    };
  }

  /** Freeze evasion: once the agent is frozen, every payment attempt must be refused. */
  async freezeEvasion(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await this.deny("freeze_evasion", { to: this.allowedPayee, amount: "1.00" });
    }
  }

  /**
   * Drain the spend-key float straight to an attacker through the facilitator (the agent fully
   * controls the spend key). This is the one movement outside policy the design accepts, and it
   * is bounded by the float (ADR 0001). Returns the amount drained on-chain.
   */
  async drainFloat(): Promise<bigint> {
    const before = this.stack.sim.balanceOf(this.drainSink.address);
    // First try to drain MORE than the float: USDC reverts (insufficient balance), nothing moves.
    const now = this.stack.clock.nowSeconds();
    const over = {
      from: getAddress(this.victim.spendKeyAddress),
      to: this.drainSink.address,
      value: String(this.floatMinor + 10_000_000n),
      validAfter: String(now - 60),
      validBefore: String(now + 600),
      nonce: keccak256(stringToHex(`rt-drain-over-${Math.random()}`)),
    };
    const overSig = await this.victim.spendKey.signTypedData(
      transferWithAuthorizationTypedData(
        { ...USDC_DOMAIN, chainId: this.stack.chainId, verifyingContract: this.stack.sim.contracts.usdc },
        over,
      ),
    );
    const overResult = await this.settleViaFacilitator(over, overSig);
    this.record({
      category: "drain_over_float",
      outcome: overResult.success ? "leaked" : "refused",
      ruleId: overResult.success ? null : (overResult.reason ?? "facilitator_rejected"),
    });

    // Now drain exactly the float (the accepted, bounded loss).
    const floatNow = this.stack.sim.balanceOf(getAddress(this.victim.spendKeyAddress));
    if (floatNow > 0n) {
      const exact = {
        from: getAddress(this.victim.spendKeyAddress),
        to: this.drainSink.address,
        value: String(floatNow),
        validAfter: String(now - 60),
        validBefore: String(now + 600),
        nonce: keccak256(stringToHex(`rt-drain-${Math.random()}`)),
      };
      const sig = await this.victim.spendKey.signTypedData(
        transferWithAuthorizationTypedData(
          { ...USDC_DOMAIN, chainId: this.stack.chainId, verifyingContract: this.stack.sim.contracts.usdc },
          exact,
        ),
      );
      const result = await this.settleViaFacilitator(exact, sig);
      this.record({
        category: "drain_float",
        outcome: result.success ? "drained" : "refused",
        ruleId: result.success ? null : (result.reason ?? "facilitator_rejected"),
        detail: result.success ? `drained ${floatNow}` : undefined,
      });
    }
    await this.stack.pump();
    return this.stack.sim.balanceOf(this.drainSink.address) - before;
  }

  /** The permission id of the victim's installed session, read straight from the chain. */
  permissionId(): Hex {
    const account = this.stack.sim.account(getAddress(this.victim.accountAddress));
    const session = account?.sessions[0];
    if (!session) throw new Error("the victim has no installed session on-chain");
    return session.permissionId;
  }

  report(): RedTeamReport {
    const byCategory: Record<string, number> = {};
    const refusalsByRule: Record<string, number> = {};
    for (const a of this.attempts) {
      byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;
      if (a.outcome !== "leaked" && a.ruleId) {
        refusalsByRule[a.ruleId] = (refusalsByRule[a.ruleId] ?? 0) + 1;
      }
    }
    const attackerGain = this.attackers.reduce((sum, a) => sum + this.stack.sim.balanceOf(a), 0n);
    return {
      attempts: this.attempts,
      total: this.attempts.length,
      byCategory,
      refusalsByRule,
      leaks: this.attempts.filter((a) => a.outcome === "leaked"),
      floatMinor: this.floatMinor,
      maxLossMinor: attackerGain,
      // Smart-account leak: attacker gains beyond the float are smart-account funds (a violation).
      smartAccountLeakMinor: attackerGain > this.floatMinor ? attackerGain - this.floatMinor : 0n,
      attackerGainMinor: attackerGain,
    };
  }
}

export { onboardAgent };
