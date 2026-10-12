"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useOwnerKey } from "@/components/owner/owner-key-provider";
import { OwnerSignerPanel } from "@/components/owner/owner-signer-panel";
import { SandboxKeyManager } from "@/components/owner/sandbox-key-manager";
import { useConsoleConfig, useSessionInfo } from "@/components/providers/config";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IconClose, IconFreeze, IconKey, IconMenu, IconSignOut } from "@/components/ui/icons";
import { consolePost } from "@/lib/api/client";
import { useApi } from "@/lib/api/hooks";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { shortHex } from "@/lib/format";
import { BrandLockup } from "./brand";
import { NavLinks } from "./nav";
import { ThemeToggle } from "./theme-toggle";

function OrgBadges() {
  const { sandbox } = useConsoleConfig();
  const org = useApi("getCurrentOrg");
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-sm font-semibold text-fg" title={org.data?.legal_name}>
        {org.data?.legal_name ?? (org.error ? "Organization" : " ")}
      </span>
      {sandbox ? <Badge tone="warn">Sandbox</Badge> : null}
      {org.data?.status === "frozen" ? (
        <Badge tone="danger" icon={<IconFreeze size={12} />}>
          Frozen
        </Badge>
      ) : null}
    </div>
  );
}

function OwnerKeyButton() {
  const owner = useOwnerKey();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium",
          owner.signer ? "border-amber/60 bg-amber-bg text-amber-fg" : "border-line text-muted hover:text-fg",
        )}
        aria-haspopup="dialog"
      >
        <IconKey size={14} />
        <span className="hidden sm:inline">Owner key:</span>
        <span className="font-mono">
          {owner.signer ? shortHex(owner.signer.address, 6, 4) : "not connected"}
        </span>
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Owner key"
        tone="owner"
        description="Loosening a policy, unfreezing, granting sessions, issuing mandates and treasury rules all need the owner key. Agent Bank never holds it."
      >
        <div className="space-y-4">
          <OwnerSignerPanel />
          <SandboxKeyManager />
        </div>
      </Dialog>
    </>
  );
}

function SignOutButton({ compact = false }: { compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      await consolePost("/api/auth/sign-out");
    } catch {
      // The cookie is cleared server-side when possible; go to sign-in either way.
    }
    window.location.assign("/sign-in");
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => void signOut()}
      loading={busy}
      icon={<IconSignOut size={16} />}
    >
      {compact ? <span className="sr-only">Sign out</span> : "Sign out"}
    </Button>
  );
}

function FrozenBanner() {
  const org = useApi("getCurrentOrg");
  if (org.data?.status !== "frozen") return null;
  const { frozen_reason: reason, pending_unfreeze_at: unfreezesAt } = org.data;
  return (
    <div role="alert" className="border-b border-danger/50 bg-danger-bg px-4 py-2.5 text-sm text-fg sm:px-6">
      <span className="font-semibold">The organization is frozen.</span>{" "}
      {unfreezesAt
        ? `The owner signed an unfreeze; it takes effect at ${formatTime(unfreezesAt)}.`
        : "The co-signer refuses every payment for every agent until the owner unfreezes it."}
      {reason ? <span className="text-muted"> Reason: {reason}.</span> : null}{" "}
      <Link href="/settings#freeze" className="font-medium text-danger-fg underline underline-offset-2">
        Review
      </Link>
    </div>
  );
}

function MobileNav() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close?.();
  }, [open]);

  // Close the drawer after navigation.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (open) setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg p-2 text-fg hover:bg-subtle lg:hidden"
        aria-label="Open navigation"
        aria-haspopup="dialog"
      >
        <IconMenu size={20} />
      </button>
      <dialog
        ref={ref}
        aria-label="Navigation"
        onCancel={(e) => {
          e.preventDefault();
          setOpen(false);
        }}
        onClick={(e) => {
          if (e.target === ref.current) setOpen(false);
        }}
        className="m-0 h-full max-h-none w-72 max-w-[85vw] border-r border-line bg-surface p-0 text-fg"
      >
        {open ? (
          <div className="flex h-full flex-col gap-4 p-4">
            <div className="flex items-center justify-between">
              <BrandLockup />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg p-2 text-muted hover:bg-subtle hover:text-fg"
                aria-label="Close navigation"
              >
                <IconClose size={18} />
              </button>
            </div>
            <NavLinks onNavigate={() => setOpen(false)} />
            <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-4">
              <ThemeToggle />
              <SignOutButton />
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}

export function ConsoleShell({ children }: { children: ReactNode }) {
  const session = useSessionInfo();
  return (
    <div className="min-h-dvh lg:pl-64">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col gap-6 border-r border-line bg-surface/80 px-4 py-5 backdrop-blur lg:flex">
        <Link href="/" className="rounded-lg px-1" aria-label="Agent Bank Console home">
          <BrandLockup />
        </Link>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NavLinks />
        </div>
        <div className="space-y-3 border-t border-line pt-4">
          {session ? (
            <p className="truncate px-1 text-xs text-muted" title={session.email}>
              {session.kind === "api_key"
                ? "Signed in with an API key (sandbox)"
                : `Signed in as ${session.email ?? "member"}`}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
      </aside>
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <MobileNav />
            <Link href="/" className="lg:hidden" aria-label="Agent Bank Console home">
              <BrandLockup subtitle="Console" className="hidden min-[420px]:inline-flex" />
            </Link>
            <div className="hidden min-w-0 flex-1 lg:block">
              <OrgBadges />
            </div>
            <div className="ml-auto flex items-center gap-2">
              <OwnerKeyButton />
            </div>
          </div>
          <div className="border-t border-line px-4 py-2 lg:hidden">
            <OrgBadges />
          </div>
        </header>
        <FrozenBanner />
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 focus:outline-none sm:px-6 lg:py-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
