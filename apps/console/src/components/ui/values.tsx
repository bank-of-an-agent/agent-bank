"use client";

import type { Money } from "@agentbank/core";
import { explorerAddressUrl, explorerTxUrl, chainLabel } from "@/lib/chains";
import { cn } from "@/lib/cn";
import { formatDateTime, formatRelative, shortHex, shortId } from "@/lib/format";
import { formatDecimal, formatMinor, type FormatOptions } from "@/lib/money";
import { CopyButton } from "./copy-button";
import { IconExternal } from "./icons";

/** A decimal amount with its asset, in tabular figures. */
export function Amount({
  value,
  asset = "USDC",
  className,
  showAsset = true,
  ...options
}: { value: string; asset?: string; className?: string; showAsset?: boolean } & FormatOptions) {
  return (
    <span className={cn("tabular whitespace-nowrap", className)}>
      {formatDecimal(value, asset, options)}
      {showAsset ? <span className="ml-1 text-xs font-normal text-muted">{asset}</span> : null}
    </span>
  );
}

export function MoneyValue({
  money,
  className,
  ...options
}: { money: Money | null | undefined; className?: string } & FormatOptions) {
  if (!money) return <span className="text-muted">—</span>;
  return <Amount value={money.amount} asset={money.asset} className={className} {...options} />;
}

export function MinorAmount({
  minor,
  asset = "USDC",
  className,
  ...options
}: { minor: bigint; asset?: string; className?: string } & FormatOptions) {
  return (
    <span className={cn("tabular whitespace-nowrap", className)}>
      {formatMinor(minor, asset, options)}
      <span className="ml-1 text-xs font-normal text-muted">{asset}</span>
    </span>
  );
}

/** An address or hash: shortened, full value on hover and copy, explorer link when the chain has one. */
export function HexValue({
  value,
  chain,
  kind = "address",
  className,
  full = false,
  label,
}: {
  value: string | null | undefined;
  chain?: string | number | null;
  kind?: "address" | "tx" | "hash";
  className?: string;
  full?: boolean;
  label?: string;
}) {
  if (!value) return <span className="text-muted">—</span>;
  const href =
    kind === "address"
      ? explorerAddressUrl(chain, value)
      : kind === "tx"
        ? explorerTxUrl(chain, value)
        : null;
  const what = label ?? (kind === "address" ? "address" : kind === "tx" ? "transaction hash" : "hash");
  return (
    <span className={cn("inline-flex max-w-full items-center gap-0.5 align-middle", className)}>
      <code
        className={cn("font-mono text-xs text-fg", full ? "break-all" : "whitespace-nowrap")}
        title={value}
      >
        {full ? value : shortHex(value, 8, 6)}
      </code>
      <CopyButton value={value} label={`Copy ${what}`} />
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md p-1 text-muted hover:bg-subtle hover:text-fg"
          aria-label={`View ${what} on the ${chainLabel(chain)} explorer (opens in a new tab)`}
        >
          <IconExternal size={14} />
        </a>
      ) : null}
    </span>
  );
}

/** A prefixed resource id (`pay_…`), shortened, with copy. */
export function IdValue({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!value) return <span className="text-muted">—</span>;
  return (
    <span className={cn("inline-flex items-center gap-0.5 align-middle", className)}>
      <code className="font-mono text-xs whitespace-nowrap" title={value}>
        {shortId(value)}
      </code>
      <CopyButton value={value} label={`Copy id ${value}`} />
    </span>
  );
}

/** A timestamp with its relative form; machine-readable via `<time>`. */
export function DateTimeValue({
  value,
  relative = false,
}: {
  value: string | null | undefined;
  relative?: boolean;
}) {
  if (!value) return <span className="text-muted">—</span>;
  return (
    <time dateTime={value} title={formatDateTime(value)} className="whitespace-nowrap">
      {relative ? formatRelative(value) : formatDateTime(value)}
    </time>
  );
}
