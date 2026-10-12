import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Empty, loading and skeleton states. Every list and detail view uses one of these. */

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-10 text-center", className)}>
      {icon ? (
        <div
          className="mb-3 flex size-11 items-center justify-center rounded-full bg-subtle text-muted"
          aria-hidden="true"
        >
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-semibold text-fg">{title}</p>
      {description ? <p className="mt-1 max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-subtle", className)} aria-hidden="true" />;
}

export function LoadingState({
  label = "Loading",
  rows = 3,
  className,
}: {
  label?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-live="polite" className={cn("space-y-3 px-4 py-5 sm:px-5", className)}>
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-5", i % 3 === 1 ? "w-2/3" : i % 3 === 2 ? "w-5/6" : "w-full")} />
      ))}
    </div>
  );
}

/** Inline note with an icon; `tone` sets the colour (owner = amber, cosigner = violet). */
export function Callout({
  tone = "info",
  title,
  children,
  icon,
  className,
}: {
  tone?: "info" | "owner" | "cosigner" | "warn" | "danger" | "success";
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-blue/40 bg-blue-bg text-fg",
    owner: "border-amber/60 bg-amber-bg text-fg",
    cosigner: "border-violet/50 bg-violet-bg text-fg",
    warn: "border-warn/50 bg-warn-bg text-fg",
    danger: "border-danger/50 bg-danger-bg text-fg",
    success: "border-teal/50 bg-teal-bg text-fg",
  } as const;
  const iconTones = {
    info: "text-blue-fg",
    owner: "text-amber-fg",
    cosigner: "text-violet-fg",
    warn: "text-warn-fg",
    danger: "text-danger-fg",
    success: "text-teal-fg",
  } as const;
  return (
    <div className={cn("flex gap-3 rounded-lg border px-4 py-3 text-sm", tones[tone], className)}>
      {icon ? <div className={cn("mt-0.5 shrink-0", iconTones[tone])}>{icon}</div> : null}
      <div className="min-w-0 space-y-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="text-fg/90">{children}</div> : null}
      </div>
    </div>
  );
}
