import type { Metadata } from "next";
import { LedgerPage } from "@/components/pages/ledger";

export const metadata: Metadata = { title: "Ledger & statements" };

export default function Page() {
  return <LedgerPage />;
}
