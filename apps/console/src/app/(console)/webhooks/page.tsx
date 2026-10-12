import type { Metadata } from "next";
import { WebhooksPage } from "@/components/pages/webhooks";

export const metadata: Metadata = { title: "Webhooks" };

export default function Page() {
  return <WebhooksPage />;
}
