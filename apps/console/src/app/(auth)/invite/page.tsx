import type { Metadata } from "next";
import { InviteForm } from "@/components/auth/invite-form";

export const metadata: Metadata = { title: "Accept invite" };

export default function InvitePage() {
  return <InviteForm />;
}
