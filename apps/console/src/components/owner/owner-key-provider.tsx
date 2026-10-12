"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useConsoleConfig } from "@/components/providers/config";
import {
  createSandboxKey,
  forgetSandboxKey,
  importSandboxKey,
  loadSandboxKey,
  sandboxKeyRaw,
  type SandboxKey,
} from "@/lib/owner/sandbox-key";
import {
  connectInjected,
  hasInjectedWallet,
  OwnerKeyError,
  sandboxSigner,
  type OwnerSigner,
} from "@/lib/owner/signer";

/**
 * Which owner key the console signs with: an injected EIP-1193 wallet, or in
 * sandbox mode a testnet-only key kept in this browser. Only signatures ever
 * leave this provider.
 */

const PREFERENCE_KEY = "agentbank.owner-signer";

type Preference = "injected" | "sandbox" | null;

function readPreference(): Preference {
  try {
    const value = window.localStorage.getItem(PREFERENCE_KEY);
    return value === "injected" || value === "sandbox" ? value : null;
  } catch {
    return null;
  }
}

function writePreference(value: Preference): void {
  try {
    if (value) window.localStorage.setItem(PREFERENCE_KEY, value);
    else window.localStorage.removeItem(PREFERENCE_KEY);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

// ---------------------------------------------------------------- sandbox key store

const sandboxListeners = new Set<() => void>();
let sandboxCache: { raw: string | null; key: SandboxKey | null } | null = null;

function notifySandbox(): void {
  sandboxListeners.forEach((listener) => listener());
}

function subscribeSandbox(listener: () => void): () => void {
  sandboxListeners.add(listener);
  const onStorage = () => notifySandbox();
  window.addEventListener("storage", onStorage);
  return () => {
    sandboxListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Re-read on every snapshot; parse only when the stored value changed (stable reference otherwise). */
function sandboxSnapshot(): SandboxKey | null {
  const raw = sandboxKeyRaw();
  if (!sandboxCache || sandboxCache.raw !== raw) sandboxCache = { raw, key: loadSandboxKey(raw) };
  return sandboxCache.key;
}

const noopSubscribe = () => () => undefined;

// ---------------------------------------------------------------- context

export interface OwnerKeyContextValue {
  signer: OwnerSigner | null;
  connecting: boolean;
  error: string | null;
  walletAvailable: boolean;
  sandboxKey: SandboxKey | null;
  sandboxAllowed: boolean;
  connectWallet: () => Promise<OwnerSigner | null>;
  selectSandbox: (options?: { create?: boolean }) => OwnerSigner | null;
  importSandbox: (privateKey: string) => OwnerSigner;
  forgetSandbox: () => void;
  disconnect: () => void;
  clearError: () => void;
}

const OwnerKeyContext = createContext<OwnerKeyContextValue | null>(null);

export function OwnerKeyProvider({ children }: { children: ReactNode }) {
  const { sandbox } = useConsoleConfig();
  const [injected, setInjected] = useState<OwnerSigner | null>(null);
  const [preference, setPreference] = useState<Preference>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const walletAvailable = useSyncExternalStore(noopSubscribe, hasInjectedWallet, () => false);
  const sandboxKey = useSyncExternalStore(subscribeSandbox, sandboxSnapshot, () => null);

  // Restore the previous choice without prompting the wallet.
  useEffect(() => {
    const stored = readPreference();
    let cancelled = false;
    if (stored === "injected" && hasInjectedWallet()) {
      connectInjected({ prompt: false })
        .then((signer) => {
          if (cancelled || !signer) return;
          setInjected(signer);
          setPreference("injected");
        })
        .catch(() => undefined);
    } else if (stored === "sandbox") {
      queueMicrotask(() => {
        if (!cancelled) setPreference("sandbox");
      });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // Follow account switches in the wallet.
  useEffect(() => {
    const provider = typeof window !== "undefined" ? window.ethereum : undefined;
    if (!provider?.on || preference !== "injected") return;
    const onAccounts = (accounts: unknown) => {
      if (!Array.isArray(accounts) || accounts.length === 0) {
        setInjected(null);
        return;
      }
      connectInjected({ prompt: false })
        .then((signer) => setInjected(signer))
        .catch(() => setInjected(null));
    };
    provider.on("accountsChanged", onAccounts as never);
    return () => provider.removeListener?.("accountsChanged", onAccounts as never);
  }, [preference]);

  const sandboxSignerValue = useMemo(
    () => (sandbox && sandboxKey ? sandboxSigner(sandboxKey.privateKey) : null),
    [sandbox, sandboxKey],
  );

  const signer = preference === "sandbox" ? sandboxSignerValue : preference === "injected" ? injected : null;

  const connectWallet = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const next = await connectInjected({ prompt: true });
      setInjected(next);
      setPreference("injected");
      writePreference("injected");
      return next;
    } catch (e) {
      setError(
        e instanceof OwnerKeyError || e instanceof Error ? e.message : "Could not connect the wallet.",
      );
      return null;
    } finally {
      setConnecting(false);
    }
  }, []);

  const selectSandbox = useCallback(
    (options: { create?: boolean } = {}) => {
      if (!sandbox) {
        setError("The sandbox owner key is only available in the sandbox.");
        return null;
      }
      setError(null);
      let key = loadSandboxKey();
      if (!key && options.create) {
        try {
          key = createSandboxKey();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Could not store the sandbox key.");
          return null;
        }
        notifySandbox();
      }
      if (!key) return null;
      setPreference("sandbox");
      writePreference("sandbox");
      return sandboxSigner(key.privateKey);
    },
    [sandbox],
  );

  const importSandbox = useCallback(
    (privateKey: string) => {
      if (!sandbox) throw new Error("The sandbox owner key is only available in the sandbox.");
      const key = importSandboxKey(privateKey);
      notifySandbox();
      setPreference("sandbox");
      writePreference("sandbox");
      return sandboxSigner(key.privateKey);
    },
    [sandbox],
  );

  const forgetSandbox = useCallback(() => {
    forgetSandboxKey();
    notifySandbox();
    setPreference((p) => (p === "sandbox" ? null : p));
    if (readPreference() === "sandbox") writePreference(null);
  }, []);

  const disconnect = useCallback(() => {
    setInjected(null);
    setPreference(null);
    writePreference(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<OwnerKeyContextValue>(
    () => ({
      signer,
      connecting,
      error,
      walletAvailable,
      sandboxKey: sandbox ? sandboxKey : null,
      sandboxAllowed: sandbox,
      connectWallet,
      selectSandbox,
      importSandbox,
      forgetSandbox,
      disconnect,
      clearError,
    }),
    [
      signer,
      connecting,
      error,
      walletAvailable,
      sandbox,
      sandboxKey,
      connectWallet,
      selectSandbox,
      importSandbox,
      forgetSandbox,
      disconnect,
      clearError,
    ],
  );

  return <OwnerKeyContext.Provider value={value}>{children}</OwnerKeyContext.Provider>;
}

export function useOwnerKey(): OwnerKeyContextValue {
  const value = useContext(OwnerKeyContext);
  if (!value) throw new Error("useOwnerKey must be used inside <OwnerKeyProvider>");
  return value;
}
