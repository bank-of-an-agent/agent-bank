"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import { useConsoleConfig } from "@/components/providers/config";
import {
  IconAgents,
  IconApprovals,
  IconBilling,
  IconChart,
  IconKey,
  IconLedger,
  IconOverview,
  IconPayments,
  IconSettings,
  IconTreasury,
  IconWebhook,
} from "@/components/ui/icons";
import { useApi } from "@/lib/api/hooks";
import { cn } from "@/lib/cn";

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Overview", icon: IconOverview },
  { href: "/agents", label: "Agents", icon: IconAgents },
  { href: "/approvals", label: "Approvals", icon: IconApprovals },
  { href: "/payments", label: "Payments", icon: IconPayments },
  { href: "/treasury", label: "Treasury", icon: IconTreasury },
  { href: "/ledger", label: "Ledger & statements", icon: IconLedger },
  { href: "/webhooks", label: "Webhooks", icon: IconWebhook },
  { href: "/api-keys", label: "API keys", icon: IconKey },
  { href: "/billing", label: "Billing", icon: IconBilling },
  { href: "/settings", label: "Settings", icon: IconSettings },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function PendingApprovalsBadge() {
  const { data } = useApi(
    "listApprovals",
    { query: { status: "pending", limit: 50 } },
    { refreshInterval: 15_000 },
  );
  const count = data?.data.length ?? 0;
  if (count === 0) return null;
  const label = data?.next_cursor ? `${count}+` : String(count);
  return (
    <span className="ml-auto rounded-full bg-warn-bg px-2 py-0.5 text-xs font-semibold text-warn-fg">
      {label}
      <span className="sr-only"> pending</span>
    </span>
  );
}

export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { staffDashboard } = useConsoleConfig();
  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active ? "bg-blue-bg text-blue-fg" : "text-muted hover:bg-subtle hover:text-fg",
            )}
          >
            <Icon size={18} className="shrink-0" />
            <span>{item.label}</span>
            {item.href === "/approvals" ? <PendingApprovalsBadge /> : null}
          </Link>
        );
      })}
      {staffDashboard ? (
        <div className="mt-4 border-t border-line pt-4">
          <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">Staff</p>
          <Link
            href="/admin/revenue"
            onClick={onNavigate}
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-subtle hover:text-fg"
          >
            <IconChart size={18} className="shrink-0" />
            <span>Revenue dashboard</span>
          </Link>
        </div>
      ) : null}
    </nav>
  );
}
