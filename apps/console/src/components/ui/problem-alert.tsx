import type { ApiProblem } from "@/lib/api/problem";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { IconAlert } from "./icons";

/**
 * RFC 9457 problem details, shown with their machine `code` and human
 * `detail` (plus field errors when the API returns them).
 */
export function ProblemAlert({
  problem,
  onRetry,
  className,
  compact = false,
}: {
  problem: ApiProblem;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex gap-3 rounded-lg border border-danger/50 bg-danger-bg px-4 py-3 text-sm text-fg",
        compact ? "" : "my-1",
        className,
      )}
    >
      <IconAlert size={18} className="mt-0.5 shrink-0 text-danger-fg" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
          <span>{problem.title}</span>
          <code className="rounded bg-surface/70 px-1.5 py-0.5 font-mono text-xs font-medium text-danger-fg">
            {problem.code}
          </code>
          {problem.status > 0 ? (
            <span className="text-xs font-normal text-muted">HTTP {problem.status}</span>
          ) : null}
        </p>
        {problem.detail ? <p className="break-words">{problem.detail}</p> : null}
        {problem.errors.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {problem.errors.map((e, i) => (
              <li key={`${e.path}-${i}`}>
                {e.path ? <code className="font-mono text-xs">{e.path}</code> : null}
                {e.path ? ": " : null}
                {e.message}
              </li>
            ))}
          </ul>
        ) : null}
        {problem.requestId ? (
          <p className="text-xs text-muted">
            Request <code className="font-mono">{problem.requestId}</code>
          </p>
        ) : null}
        {onRetry ? (
          <div className="pt-1">
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
