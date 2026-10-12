import type { Metadata } from "next";
import { AgentDetailPage } from "@/components/pages/agent-detail";

export const metadata: Metadata = { title: "Agent" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentDetailPage id={id} />;
}
