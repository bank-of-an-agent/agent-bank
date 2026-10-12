"use client";

import type { ReactNode } from "react";
import { SWRConfig, type SWRConfiguration } from "swr";
import { OwnerKeyProvider } from "@/components/owner/owner-key-provider";
import { ToastProvider } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api/problem";

const swrConfig: SWRConfiguration = {
  revalidateOnFocus: true,
  dedupingInterval: 2_000,
  errorRetryCount: 2,
  onErrorRetry: (error, _key, config, revalidate, { retryCount }) => {
    // Client errors (bad input, missing scope, not found, CSRF) will not fix themselves.
    if (error instanceof ApiProblem && error.status >= 400 && error.status < 500) return;
    if (retryCount >= (config.errorRetryCount ?? 2)) return;
    window.setTimeout(() => void revalidate({ retryCount }), 1_500 * 2 ** retryCount);
  },
};

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={swrConfig}>
      <ToastProvider>
        <OwnerKeyProvider>{children}</OwnerKeyProvider>
      </ToastProvider>
    </SWRConfig>
  );
}
