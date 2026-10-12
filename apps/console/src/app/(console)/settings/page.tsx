import type { Metadata } from "next";
import { SettingsPage } from "@/components/pages/settings";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return <SettingsPage />;
}
