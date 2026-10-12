import type { Metadata } from "next";
import { PaymentDetailPage } from "@/components/pages/payment-detail";

export const metadata: Metadata = { title: "Payment" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PaymentDetailPage id={id} />;
}
