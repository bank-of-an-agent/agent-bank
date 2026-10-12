import type { Metadata } from "next";
import { RevenuePage } from "@/components/pages/revenue";

export const metadata: Metadata = { title: "Revenue (staff)" };

export default function Page() {
  return <RevenuePage />;
}
