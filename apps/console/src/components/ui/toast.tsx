"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconCheck, IconClose, IconInfo } from "./icons";

export interface Toast {
  id: number;
  title: string;
  description?: string;
  tone?: "success" | "info" | "warn";
}

const ToastContext = createContext<((toast: Omit<Toast, "id">) => void) | null>(null);

let nextId = 1;

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), 6000);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);
  const tone = toast.tone ?? "success";
  return (
    <div
      className={cn(
        "pointer-events-auto flex w-full max-w-sm gap-3 rounded-lg border bg-surface px-4 py-3 text-sm shadow-lg",
        tone === "success" ? "border-teal/60" : tone === "warn" ? "border-warn/60" : "border-blue/50",
      )}
    >
      <span
        className={cn(
          "mt-0.5",
          tone === "success" ? "text-teal-fg" : tone === "warn" ? "text-warn-fg" : "text-blue-fg",
        )}
      >
        {tone === "success" ? <IconCheck size={16} /> : <IconInfo size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">{toast.title}</p>
        {toast.description ? <p className="mt-0.5 text-muted">{toast.description}</p> : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="-mr-1 h-fit rounded p-1 text-muted hover:bg-subtle hover:text-fg"
        aria-label="Dismiss notification"
      >
        <IconClose size={14} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = nextId++;
    setToasts((list) => [...list.slice(-3), { ...toast, id }]);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (toast: Omit<Toast, "id">) => void {
  const push = useContext(ToastContext);
  return push ?? (() => undefined);
}
