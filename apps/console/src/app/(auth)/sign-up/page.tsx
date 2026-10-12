import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { serverConfig } from "@/lib/server/env";

export const metadata: Metadata = { title: "Create a sandbox org" };

export default function SignUpPage() {
  // Self-serve sign-up exists only in the sandbox.
  if (!serverConfig().sandbox) notFound();
  return <SignUpForm />;
}
