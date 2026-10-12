import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignInForm } from "@/components/auth/sign-in-form";
import { safeNextPath } from "@/lib/next-path";
import { currentPrincipal } from "@/lib/server/current";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  if (await currentPrincipal()) redirect(next);
  return <SignInForm next={next} expired={params.expired === "1"} />;
}
