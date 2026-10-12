import type { Metadata } from "next";
import { OwnerOperationCard } from "@/components/owner/owner-operation";
import { PageHeader } from "@/components/ui/layout";

export const metadata: Metadata = { title: "Owner operation" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <PageHeader
        title="Owner operation"
        description="An on-chain operation only your owner key can authorize. Agent Bank prepared it and cannot sign it."
        crumbs={[{ href: "/owner-operations", label: "Owner operations" }, { label: id }]}
      />
      <OwnerOperationCard id={id} title="Sign with the owner key" />
    </>
  );
}
