"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * The API has no list endpoints for sessions or mandates yet, so the console
 * remembers the ids it created or looked up, per agent, in this browser
 * (ids only, nothing secret). Pages label these lists accordingly.
 */

const PREFIX = "agentbank.known";
const MAX = 50;
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; ids: string[] }>();

function storageKey(scope: string): string {
  return `${PREFIX}.${scope}`;
}

function readRaw(scope: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(scope));
  } catch {
    return null;
  }
}

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Cached per raw value so `useSyncExternalStore` sees a stable snapshot. */
function read(scope: string): string[] {
  const raw = readRaw(scope);
  const cached = cache.get(scope);
  if (cached && cached.raw === raw) return cached.ids;
  const ids = parseIds(raw);
  cache.set(scope, { raw, ids });
  return ids;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

const EMPTY: string[] = [];

export function useKnownIds(scope: string): [string[], (id: string) => void, (id: string) => void] {
  const ids = useSyncExternalStore(
    subscribe,
    () => read(scope),
    () => EMPTY,
  );
  const write = useCallback(
    (next: string[]) => {
      try {
        window.localStorage.setItem(storageKey(scope), JSON.stringify(next.slice(0, MAX)));
      } catch {
        return;
      }
      listeners.forEach((l) => l());
    },
    [scope],
  );
  const remember = useCallback(
    (id: string) => {
      const current = read(scope);
      if (!current.includes(id)) write([id, ...current]);
    },
    [scope, write],
  );
  const forget = useCallback((id: string) => write(read(scope).filter((x) => x !== id)), [scope, write]);
  return [ids, remember, forget];
}
