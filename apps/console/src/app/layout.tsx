import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: { default: "Agent Bank Console", template: "%s · Agent Bank" },
  description: "Control agents, approvals, policies and money movement for your Agent Bank org.",
  applicationName: "Agent Bank Console",
  icons: { icon: [{ url: "/mark.svg", type: "image/svg+xml" }] },
  robots: { index: false, follow: false },
  referrer: "strict-origin-when-cross-origin",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f8fd" },
    { media: "(prefers-color-scheme: dark)", color: "#070b16" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading the request headers makes every page dynamic, which the per-request CSP nonce requires.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Theme before first paint; the content is a constant (src/lib/theme.ts). */}
        {/* eslint-disable-next-line no-restricted-syntax */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
