"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { IconCheck, IconCopy } from "./icons";

export function CopyButton({
  value,
  label = "Copy",
  className,
  showLabel = false,
}: {
  value: string;
  /** Accessible name, e.g. "Copy address". */
  label?: string;
  className?: string;
  showLabel?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        "inline-flex items-center gap-1 rounded-md p-1 text-muted hover:bg-subtle hover:text-fg",
        showLabel && "px-2 text-xs font-medium",
        className,
      )}
      aria-label={showLabel ? undefined : label}
    >
      {copied ? <IconCheck size={14} className="text-teal-fg" /> : <IconCopy size={14} />}
      {showLabel ? <span>{copied ? "Copied" : label}</span> : null}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </button>
  );
}
