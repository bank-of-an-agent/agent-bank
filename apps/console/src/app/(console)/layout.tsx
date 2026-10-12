import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Misconfigured } from "@/components/misconfigured";
import { AppProviders } from "@/components/providers/app-providers";
import { ConfigProvider, SessionProvider, type ConsoleConfig } from "@/components/providers/config";
import { ConsoleShell } from "@/components/shell/console-shell";
import { resolveDeployment } from "@/lib/server/chain";
import { currentPrincipal } from "@/lib/server/current";
import { ConfigError, publicConfig, sessionSecret } from "@/lib/server/env";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  let base;
  try {
    base = publicConfig();
    sessionSecret();
  } catch (error) {
    if (error instanceof ConfigError) return <Misconfigured message={error.message} />;
    throw error;
  }
  const session = await currentPrincipal();
  if (!session) redirect("/sign-in?expired=1");
  const deployment = await resolveDeployment();
  const config: ConsoleConfig = {
    sandbox: base.sandbox,
    staffDashboard: base.staffDashboard,
    chain: deployment.chain,
    chainId: deployment.chainId,
    features: deployment.features,
  };
  return (
    <ConfigProvider value={config}>
      <SessionProvider
        value={{ kind: session.kind, email: session.email, role: session.role, expiresAt: session.exp }}
      >
        <AppProviders>
          <ConsoleShell>{children}</ConsoleShell>
        </AppProviders>
      </SessionProvider>
    </ConfigProvider>
  );
}
