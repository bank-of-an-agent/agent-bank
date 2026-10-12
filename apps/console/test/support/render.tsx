import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { SWRConfig } from "swr";
import { OwnerKeyProvider } from "@/components/owner/owner-key-provider";
import {
  ConfigProvider,
  SessionProvider,
  type ConsoleConfig,
  type SessionInfo,
} from "@/components/providers/config";
import { ToastProvider } from "@/components/ui/toast";

export const testConfig: ConsoleConfig = {
  sandbox: true,
  staffDashboard: true,
  chain: "base-sepolia",
  chainId: 84532,
  features: {},
};

export function renderWithProviders(
  ui: ReactElement,
  {
    config = testConfig,
    session = { kind: "passkey", email: "ada@acme.test", role: "admin", expiresAt: Date.now() / 1000 + 3600 },
    ...options
  }: RenderOptions & { config?: ConsoleConfig; session?: SessionInfo | null } = {},
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ConfigProvider value={config}>
        <SessionProvider value={session}>
          <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <ToastProvider>
              <OwnerKeyProvider>{children}</OwnerKeyProvider>
            </ToastProvider>
          </SWRConfig>
        </SessionProvider>
      </ConfigProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...options });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" },
  });
}
