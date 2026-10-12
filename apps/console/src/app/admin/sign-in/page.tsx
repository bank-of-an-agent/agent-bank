import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { StaffSignInForm } from "@/components/auth/staff-sign-in-form";
import { safeNextPath } from "@/lib/next-path";
import { currentStaff } from "@/lib/server/current";

export const metadata: Metadata = { title: "Staff sign-in" };

export default async function StaffSignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null, "/admin/revenue");
  if (await currentStaff()) redirect(next.startsWith("/admin/") ? next : "/admin/revenue");
  return <StaffSignInForm next={next.startsWith("/admin/") ? next : "/admin/revenue"} />;
}
