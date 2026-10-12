import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { humanize } from "@/lib/format";

export type Tone = "neutral" | "blue" | "teal" | "amber" | "violet" | "danger" | "warn";

const tones: Record<Tone, string> = {
  neutral: "bg-neutral-bg text-neutral-fg",
  blue: "bg-blue-bg text-blue-fg",
  teal: "bg-teal-bg text-teal-fg",
  amber: "bg-amber-bg text-amber-fg",
  violet: "bg-violet-bg text-violet-fg",
  danger: "bg-danger-bg text-danger-fg",
  warn: "bg-warn-bg text-warn-fg",
};

export function Badge({
  tone = "neutral",
  children,
  className,
  icon,
  wrap = false,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
  /** Let long text wrap (e.g. a sentence in a narrow column) instead of staying on one line. */
  wrap?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium",
        wrap ? "rounded-lg whitespace-normal" : "rounded-full whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** Colour for a resource status. Text always carries the meaning; colour only reinforces it. */
const STATUS_TONES: Record<string, Tone> = {
  // payments
  settled: "teal",
  submitted: "blue",
  requires_signature: "blue",
  requires_approval: "warn",
  denied: "danger",
  failed: "danger",
  canceled: "neutral",
  expired: "neutral",
  // approvals
  pending: "warn",
  approved: "teal",
  // agents, orgs, sessions, mandates, rules
  active: "teal",
  frozen: "danger",
  pending_install: "amber",
  revoked: "neutral",
  disabled: "neutral",
  enabled: "teal",
  // escrow / streams
  locking: "blue",
  locked: "violet",
  released: "teal",
  refunded: "neutral",
  disputed: "warn",
  resolved: "teal",
  completed: "teal",
  paused: "neutral",
  // kyb
  in_review: "blue",
  rejected: "danger",
  // owner operations
  succeeded: "teal",
  // policy decisions
  allow: "teal",
  deny: "danger",
  require_approval: "warn",
  require_owner: "amber",
  // subscriptions
  past_due: "warn",
  // policy versions
  initial: "blue",
  tighten: "teal",
  loosen: "amber",
  mixed: "amber",
  unchanged: "neutral",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={STATUS_TONES[status] ?? "neutral"}>{label ?? humanize(status)}</Badge>;
}
