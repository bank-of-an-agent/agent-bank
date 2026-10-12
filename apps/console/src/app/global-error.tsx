"use client";

import "./globals.css";

/** Replaces the root layout when it fails; keep it dependency-free. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
          <h1 className="text-2xl font-semibold">Agent Bank Console is unavailable</h1>
          <p className="text-sm text-muted">
            An unexpected error stopped the console from loading.
            {error.digest ? ` Reference ${error.digest}.` : ""}
          </p>
          <button
            type="button"
            onClick={reset}
            className="w-fit rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
