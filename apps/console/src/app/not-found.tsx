import Link from "next/link";
import { BrandLockup } from "@/components/shell/brand";
import { buttonClasses } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-4">
      <BrandLockup />
      <div className="space-y-2">
        <p className="font-mono text-sm text-muted">404 · not_found</p>
        <h1 className="text-2xl font-semibold tracking-tight">This page does not exist</h1>
        <p className="text-sm text-muted">Check the address, or go back to the overview.</p>
      </div>
      <Link href="/" className={buttonClasses("primary", "md", "w-fit")}>
        Go to the overview
      </Link>
    </main>
  );
}
