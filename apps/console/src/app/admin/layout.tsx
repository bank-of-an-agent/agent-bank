import { CHAINS } from "@agentbank/core";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Misconfigured } from "@/components/misconfigured";
import { AppProviders } from "@/components/providers/app-providers";
import { ConfigProvider } from "@/components/providers/config";
import { ConfigError, publicConfig, sessionSecret } from "@/lib/server/env";

/** Internal staff area. Disabled unless STAFF_DASHBOARD_ENABLED (default: sandbox only). */
export default function AdminLayout({ children }: { children: ReactNode }) {
  let config;
  try {
    config = publicConfig();
    sessionSecret();
  } catch (error) {
    if (error instanceof ConfigError) return <Misconfigured message={error.message} />;
    throw error;
  }
  if (!config.staffDashboard) notFound();
  return (
    <ConfigProvider value={{ ...config, chainId: CHAINS[config.chain].id, features: {} }}>
      <AppProviders>{children}</AppProviders>
    </ConfigProvider>
  );
}
