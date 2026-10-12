import type { Metadata } from "next";
import { TreasuryPage } from "@/components/pages/treasury";

export const metadata: Metadata = { title: "Treasury" };

export default function Page() {
  return <TreasuryPage />;
}
