"use client";

import type { PolicyDecisionWire } from "@agentbank/core";
import Link from "next/link";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { HexValue } from "@/components/ui/values";
import type { Agent, Payment } from "@/lib/api/queries";
import { humanize } from "@/lib/format";

export const PAYMENT_KIND_LABELS: Record<string, string> = {
  transfer: "Transfer",
  x402: "x402",
  escrow: "Escrow",
  stream: "Stream",
  payout: "Payout",
  refill: "Spend-key refill",
  vault: "Vault deposit",
};

export function kindLabel(kind: string): string {
  return PAYMENT_KIND_LABELS[kind] ?? humanize(kind);
}

type Counterparty = Payment["counterparty"];

/** Who the money goes to, in the most useful form for its type. */
export function CounterpartyLabel({
  counterparty,
  agents,
  chain,
}: {
  counterparty: Counterparty;
  agents?: Map<string, Agent>;
  chain?: string | number | null;
}) {
  if (counterparty.type === "agent" && counterparty.agent_id) {
    const agent = agents?.get(counterparty.agent_id);
    return (
      <span className="inline-flex flex-col">
        <Link href={`/agents/${counterparty.agent_id}`} className="font-medium text-blue-fg hover:underline">
          {agent?.name ?? counterparty.agent_id}
        </Link>
        <span className="text-xs text-muted">Agent Bank agent</span>
      </span>
    );
  }
  if (counterparty.type === "x402" && counterparty.x402_domain) {
    return (
      <span className="inline-flex flex-col">
        <span className="font-medium">{counterparty.x402_domain}</span>
        <span className="text-xs text-muted">x402 seller</span>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col">
      <HexValue value={counterparty.address} chain={chain} />
      <span className="text-xs text-muted">
        {counterparty.type === "escrow"
          ? "Escrow contract"
          : counterparty.type === "stream"
            ? "Stream contract"
            : "Address"}
      </span>
    </span>
  );
}

const EFFECT_TONES = {
  allow: "teal",
  deny: "danger",
  require_approval: "warn",
  require_owner: "amber",
  info: "neutral",
} as const;

/** The policy engine's decision: outcome plus every rule that fired. Violet marks the co-signer's policy engine. */
export function DecisionView({ decision }: { decision: PolicyDecisionWire | null | undefined }) {
  if (!decision) return <p className="text-sm text-muted">No policy decision recorded.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Outcome</span>
        <StatusBadge status={decision.outcome} />
        {decision.approvers_required > 0 ? (
          <Badge tone="warn">
            {decision.approvers_required} approver{decision.approvers_required === 1 ? "" : "s"} required
          </Badge>
        ) : null}
        <span className="text-xs text-muted">Policy v{decision.policy_version}</span>
      </div>
      <RuleHits hits={decision.rule_hits} />
    </div>
  );
}

export function RuleHits({ hits }: { hits: PolicyDecisionWire["rule_hits"] }) {
  if (hits.length === 0) return <p className="text-sm text-muted">No rules fired.</p>;
  return (
    <ul className="space-y-2.5" aria-label="Rule hits">
      {hits.map((hit, i) => (
        <li key={`${hit.rule}-${i}`} className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="violet">
              <code className="font-mono">{hit.rule}</code>
            </Badge>
            <Badge tone={EFFECT_TONES[hit.effect]}>{humanize(hit.effect)}</Badge>
          </div>
          <p className="text-sm text-fg">{hit.detail}</p>
        </li>
      ))}
    </ul>
  );
}
