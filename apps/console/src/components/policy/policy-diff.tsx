"use client";

import { Badge, type Tone } from "@/components/ui/badge";
import { IconKey } from "@/components/ui/icons";
import { Callout } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { explainDiff, LOOSENING_DELAY_MINUTES, type Direction, type PolicyDiff } from "@/lib/policy/diff";

const KIND_BADGES: Record<PolicyDiff["kind"], { tone: Tone; label: string }> = {
  tighten: { tone: "teal", label: "Tightens · applies immediately" },
  loosen: { tone: "amber", label: `Loosens · owner key + ${LOOSENING_DELAY_MINUTES} min delay` },
  mixed: { tone: "amber", label: `Mixed · treated as loosening` },
  initial: { tone: "amber", label: "First policy · owner key, applies immediately" },
  unchanged: { tone: "neutral", label: "No effective change" },
};

const DIRECTION_BADGES: Record<Direction, { tone: Tone; label: string }> = {
  tighten: { tone: "teal", label: "Tightens" },
  loosen: { tone: "amber", label: "Loosens" },
  neutral: { tone: "neutral", label: "Neutral" },
};

/**
 * The live diff of the policy editor: every change labelled tighten or
 * loosen (classified by `@agentbank/policy`, like the server), and what
 * saving will require.
 */
export function diffBadge(diff: PolicyDiff): { tone: Tone; label: string } {
  return diff.kind === "unchanged" && diff.autoSaveChanged
    ? { tone: "amber", label: "Auto-save edit · owner key, no delay" }
    : KIND_BADGES[diff.kind];
}

export function PolicyDiffPanel({
  diff,
  title = "Changes",
  variant = "draft",
}: {
  diff: PolicyDiff;
  title?: string;
  /** `compact` lists the changes without the "saving will…" guidance (pending versions, signing dialogs). */
  variant?: "draft" | "compact";
}) {
  const badge = diffBadge(diff);
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      {variant === "draft" ? <p className="text-sm text-muted">{explainDiff(diff)}</p> : null}
      {variant === "draft" && diff.requiresOwner ? (
        <Callout tone="owner" icon={<IconKey size={16} />} title="Owner key required">
          {diff.delayed ? (
            <>
              Saving asks the owner key to sign an{" "}
              <code className="font-mono text-xs">OwnerAuthorization</code> (
              <code className="font-mono text-xs">policy.loosen</code>). The new version becomes pending and
              takes effect {LOOSENING_DELAY_MINUTES} minutes later (about {formatTime(diff.effectiveAt)} if
              signed now). Tightening rules in the same change wait too.
            </>
          ) : (
            <>
              Saving asks the owner key to sign an{" "}
              <code className="font-mono text-xs">OwnerAuthorization</code> (
              <code className="font-mono text-xs">policy.loosen</code>); the policy applies as soon as it is
              signed.
            </>
          )}
        </Callout>
      ) : null}
      {diff.items.length > 0 ? (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Policy changes">
          {diff.items.map((item) => {
            const direction = DIRECTION_BADGES[item.direction];
            return (
              <li
                key={item.key}
                className="flex flex-col gap-1 px-3 py-2.5 text-sm sm:flex-row sm:items-start sm:gap-3"
              >
                <Badge tone={direction.tone} className="w-fit shrink-0">
                  {direction.label}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-words">{item.label}</p>
                  {item.before || item.after ? (
                    <p className={cn("text-xs text-muted break-words")}>
                      {item.before ? (
                        <>
                          <span className="line-through decoration-muted/60">{item.before}</span>
                          <span aria-hidden="true"> → </span>
                          <span className="sr-only"> changes to </span>
                        </>
                      ) : null}
                      <span className="text-fg">{item.after}</span>
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
