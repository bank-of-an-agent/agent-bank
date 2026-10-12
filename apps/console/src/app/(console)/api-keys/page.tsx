import type { Metadata } from "next";
import { ApiKeysPage } from "@/components/pages/api-keys";

export const metadata: Metadata = { title: "API keys" };

export default function Page() {
  return <ApiKeysPage />;
}
