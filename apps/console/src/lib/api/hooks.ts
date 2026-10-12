"use client";

import type { OperationId, ResponseOf } from "@agentbank/core/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR, { useSWRConfig, type SWRConfiguration } from "swr";
import useSWRInfinite from "swr/infinite";
import { apiFetch, newIdempotencyKey, type ApiArgs, type ApiArgsTuple } from "./client";
import { ApiProblem } from "./problem";

/** SWR keys are `[operationId, serialized args]`, so invalidation can target operations. */
export type ApiKey = readonly [OperationId, string];

function stableStringify(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return v;
  });
}

/**
 * `mutate(filter)` in SWR skips `useSWRInfinite` keys, so paginated lists
 * subscribe here and are revalidated alongside plain queries.
 */
const listListeners = new Map<OperationId, Set<() => void>>();

function subscribeList(op: OperationId, listener: () => void): () => void {
  let set = listListeners.get(op);
  if (!set) {
    set = new Set();
    listListeners.set(op, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

function call<K extends OperationId>(op: K, args: ApiArgs<K> | undefined): Promise<ResponseOf<K>> {
  return (apiFetch as (op: K, args?: ApiArgs<K>) => Promise<ResponseOf<K>>)(op, args);
}

/** Read an operation. Pass `null` as the operation to wait (dependent queries). */
export function useApi<K extends OperationId>(
  op: K | null,
  args?: ApiArgs<K>,
  config?: SWRConfiguration<ResponseOf<K>, ApiProblem>,
) {
  const key: ApiKey | null = op ? [op, stableStringify(args)] : null;
  return useSWR<ResponseOf<K>, ApiProblem, ApiKey | null>(
    key,
    key ? () => call(op as K, args) : null,
    config,
  );
}

type PageOf<K extends OperationId> =
  ResponseOf<K> extends { data: (infer T)[]; next_cursor: string | null }
    ? { data: T[]; next_cursor: string | null }
    : never;

type ItemOf<K extends OperationId> = PageOf<K> extends { data: (infer T)[] } ? T : never;

/** Cursor-paginated list with "load more". */
export function useApiList<K extends OperationId>(
  op: K | null,
  args?: ApiArgs<K>,
  config?: { refreshInterval?: number },
) {
  const getKey = (index: number, previous: PageOf<K> | null): ApiKey | null => {
    if (!op) return null;
    if (index > 0 && (!previous || !previous.next_cursor)) return null;
    const loose = (args ?? {}) as { query?: Record<string, unknown> };
    const query = {
      ...(loose.query ?? {}),
      ...(index > 0 && previous ? { cursor: previous.next_cursor } : {}),
    };
    return [op, stableStringify({ ...args, query })];
  };
  const result = useSWRInfinite<PageOf<K>, ApiProblem, typeof getKey>(
    getKey,
    (key: ApiKey) => {
      const parsed = (key[1] ? JSON.parse(key[1]) : undefined) as ApiArgs<K> | undefined;
      return call(key[0] as K, parsed) as Promise<PageOf<K>>;
    },
    { revalidateFirstPage: true, refreshInterval: config?.refreshInterval },
  );
  const pages = result.data;
  const items = useMemo(() => (pages ?? []).flatMap((p) => p.data as ItemOf<K>[]), [pages]);
  const last = pages?.[pages.length - 1];
  const hasMore = Boolean(last?.next_cursor);
  const isLoadingMore =
    result.isLoading ||
    (result.size > 0 && pages !== undefined && typeof pages[result.size - 1] === "undefined");
  const { setSize, mutate } = result;
  const loadMore = useCallback(() => setSize((s) => s + 1), [setSize]);
  useEffect(() => (op ? subscribeList(op, () => void mutate()) : undefined), [op, mutate]);
  return {
    items,
    error: result.error,
    isLoading: result.isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
    mutate: result.mutate,
    isValidating: result.isValidating,
  };
}

/** Revalidate every cached query of the given operations (after a mutation). */
export function useInvalidate() {
  const { mutate } = useSWRConfig();
  return useCallback(
    async (...ops: OperationId[]) => {
      for (const op of ops) listListeners.get(op)?.forEach((listener) => listener());
      await mutate((key) => Array.isArray(key) && ops.includes(key[0] as OperationId));
    },
    [mutate],
  );
}

export interface MutationState {
  pending: boolean;
  error: ApiProblem | null;
}

/**
 * Run a write. Errors are captured as problems for display instead of
 * thrown, and the listed operations are revalidated afterwards.
 */
export function useMutation<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: { invalidates?: OperationId[] } = {},
) {
  const [state, setState] = useState<MutationState>({ pending: false, error: null });
  const invalidate = useInvalidate();
  const invalidates = options.invalidates;
  const run = useCallback(
    async (...args: TArgs): Promise<{ ok: true; data: TResult } | { ok: false; problem: ApiProblem }> => {
      setState({ pending: true, error: null });
      try {
        const data = await fn(...args);
        setState({ pending: false, error: null });
        if (invalidates?.length) void invalidate(...invalidates);
        return { ok: true, data };
      } catch (error) {
        const problem = ApiProblem.from(error);
        setState({ pending: false, error: problem });
        return { ok: false, problem };
      }
    },
    [fn, invalidate, invalidates],
  );
  const reset = useCallback(() => setState({ pending: false, error: null }), []);
  return { ...state, run, reset };
}

/** One idempotency key per user intent: reused on retry, rotated after success. */
export function useIdempotencyKey(): [string, () => void] {
  const [key, setKey] = useState(newIdempotencyKey);
  const rotate = useCallback(() => setKey(newIdempotencyKey()), []);
  return [key, rotate];
}

export { apiFetch };
export type { ApiArgs, ApiArgsTuple };
