import type { Metadata } from "next";
import { ApprovalsPage } from "@/components/pages/approvals";

export const metadata: Metadata = { title: "Approvals" };

export default function Page() {
  return <ApprovalsPage />;
}
