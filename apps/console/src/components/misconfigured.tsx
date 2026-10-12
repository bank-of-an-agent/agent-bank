import { BrandLockup } from "@/components/shell/brand";

/** Shown instead of the app when the console server's environment is invalid. */
export function Misconfigured({ message }: { message: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 px-4">
      <BrandLockup />
      <div role="alert" className="rounded-xl border border-danger/50 bg-danger-bg px-5 py-4 text-sm">
        <p className="font-semibold">
          The console is misconfigured <code className="ml-1 font-mono text-xs">console_misconfigured</code>
        </p>
        <p className="mt-1 break-words">{message}</p>
      </div>
    </main>
  );
}
