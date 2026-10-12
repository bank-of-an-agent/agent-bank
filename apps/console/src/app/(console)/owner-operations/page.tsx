import type { Metadata } from "next";
import { OwnerOperationsPage } from "@/components/pages/owner-operations";

export const metadata: Metadata = { title: "Owner operations" };

export default function Page() {
  return <OwnerOperationsPage />;
}
