import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { StaffShell } from "@/components/shell/staff-shell";
import { currentStaff } from "@/lib/server/current";

export default async function StaffLayout({ children }: { children: ReactNode }) {
  if (!(await currentStaff())) redirect("/admin/sign-in");
  return <StaffShell>{children}</StaffShell>;
}
