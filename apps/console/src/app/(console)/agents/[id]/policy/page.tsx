import type { Metadata } from "next";
import { PolicyPage } from "@/components/pages/policy";

export const metadata: Metadata = { title: "Policy editor" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PolicyPage agentId={id} />;
}
