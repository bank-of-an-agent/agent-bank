import type { Metadata } from "next";
import { AgentsPage } from "@/components/pages/agents";

export const metadata: Metadata = { title: "Agents" };

export default function Page() {
  return <AgentsPage />;
}
