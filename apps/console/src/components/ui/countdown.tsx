"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { describeDuration, formatCountdown, formatTime } from "@/lib/format";
import { IconClock } from "./icons";

/** Current time, ticking every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * A live countdown to `to`. Sighted users see mm:ss tick; assistive
 * technology gets a stable label ("expires at 14:32, in 9 minutes") instead of
 * an announcement every second.
 */
export function Countdown({
  to,
  label = "Expires",
  warnBelowMs = 2 * 60_000,
  expiredText = "Expired",
  className,
}: {
  to: string;
  label?: string;
  warnBelowMs?: number;
  expiredText?: string;
  className?: string;
}) {
  const now = useNow(1000);
  const target = new Date(to).getTime();
  const remaining = target - now;
  const expired = Number.isFinite(target) && remaining <= 0;
  const warn = !expired && remaining <= warnBelowMs;
  const minuteBucket = Math.ceil(Math.max(remaining, 0) / 60_000);
  const spoken = expired
    ? `${expiredText} at ${formatTime(to)}`
    : `${label} at ${formatTime(to)}, in about ${describeDuration(minuteBucket * 60_000)}`;

  return (
    <span
      role="timer"
      aria-live="off"
      aria-label={spoken}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs font-medium tabular",
        expired
          ? "bg-neutral-bg text-neutral-fg"
          : warn
            ? "bg-warn-bg text-warn-fg"
            : "bg-blue-bg text-blue-fg",
        className,
      )}
    >
      <IconClock size={12} />
      <span aria-hidden="true">{expired ? expiredText : formatCountdown(remaining)}</span>
    </span>
  );
}
