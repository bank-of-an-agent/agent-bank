import { CHAINS } from "@agentbank/core";
import type { ReactNode } from "react";
import { Misconfigured } from "@/components/misconfigured";
import { AppProviders } from "@/components/providers/app-providers";
import { ConfigProvider } from "@/components/providers/config";
import { BrandLockup } from "@/components/shell/brand";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { ConfigError, publicConfig, sessionSecret } from "@/lib/server/env";

export default function AuthLayout({ children }: { children: ReactNode }) {
  let config;
  try {
    config = publicConfig();
    sessionSecret();
  } catch (error) {
    if (error instanceof ConfigError) return <Misconfigured message={error.message} />;
    throw error;
  }
  return (
    <ConfigProvider value={{ ...config, chainId: CHAINS[config.chain].id, features: {} }}>
      <AppProviders>
        <div className="flex min-h-dvh flex-col">
          <header className="flex items-center justify-between px-4 py-4 sm:px-8">
            <BrandLockup subtitle={config.sandbox ? "Sandbox console" : "Console"} />
            <ThemeToggle />
          </header>
          <main id="main" className="flex flex-1 items-start justify-center px-4 pt-6 pb-16 sm:pt-12">
            <div className="w-full max-w-md">{children}</div>
          </main>
          <footer className="px-4 pb-6 text-center text-xs text-muted">
            Non-custodial: Agent Bank can refuse a payment, never make one. Testnet only.
          </footer>
        </div>
      </AppProviders>
    </ConfigProvider>
  );
}
