"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { IconAlert } from "@/components/ui/icons";

/** Unexpected rendering errors. API problems are shown inline where they happen; this is the last resort. */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div
      role="alert"
      className="mx-auto max-w-lg space-y-4 rounded-xl border border-danger/50 bg-danger-bg px-6 py-5"
    >
      <p className="flex items-center gap-2 font-semibold">
        <IconAlert size={18} className="text-danger-fg" />
        Something went wrong on this page
      </p>
      <p className="text-sm">
        The console hit an unexpected error. Your data is safe: nothing was sent.
        {error.digest ? (
          <>
            {" "}
            Reference <code className="font-mono text-xs">{error.digest}</code>.
          </>
        ) : null}
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
