"use client";

import type { ChainName } from "@agentbank/core";
import { createContext, useContext, type ReactNode } from "react";

/** Runtime settings the server hands to the browser (no secrets). */
export interface ConsoleConfig {
  sandbox: boolean;
  staffDashboard: boolean;
  /** The chain the API runs on (`GET /v1/meta`). */
  chain: ChainName;
  /** EIP-712 domain chain id for owner authorizations (`owner_authorization_chain_id`). */
  chainId: number;
  /** Feature flags from `GET /v1/meta`, e.g. `treasury_sweep`. */
  features: Record<string, boolean>;
}

/** What the browser may know about the signed-in principal (never the credential). */
export interface SessionInfo {
  kind: "api_key" | "passkey";
  email?: string;
  role?: string;
  expiresAt: number;
}

const ConfigContext = createContext<ConsoleConfig>({
  sandbox: false,
  staffDashboard: false,
  chain: "base-sepolia",
  chainId: 84532,
  features: {},
});

const SessionContext = createContext<SessionInfo | null>(null);

export function ConfigProvider({ value, children }: { value: ConsoleConfig; children: ReactNode }) {
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function SessionProvider({ value, children }: { value: SessionInfo | null; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useConsoleConfig(): ConsoleConfig {
  return useContext(ConfigContext);
}

export function useSessionInfo(): SessionInfo | null {
  return useContext(SessionContext);
}
