"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconSignOut } from "@/components/ui/icons";
import { consolePost } from "@/lib/api/client";
import { BrandLockup } from "./brand";
import { ThemeToggle } from "./theme-toggle";

/** Chrome for Agent Bank staff pages: separate from the principal console and its session. */
export function StaffShell({ children }: { children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Link href="/admin/revenue" aria-label="Staff dashboard home">
            <BrandLockup subtitle="Staff" />
          </Link>
          <Badge tone="violet">Internal</Badge>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <Button
              size="sm"
              variant="ghost"
              loading={busy}
              icon={<IconSignOut size={16} />}
              onClick={async () => {
                setBusy(true);
                try {
                  await consolePost("/api/admin/sign-out");
                } catch {
                  // Clear locally either way.
                }
                window.location.assign("/admin/sign-in");
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-7xl px-4 py-6 focus:outline-none sm:px-6 lg:py-8"
      >
        {children}
      </main>
    </div>
  );
}
