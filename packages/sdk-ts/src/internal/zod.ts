import type { z } from "zod";

/** One validation problem: where and what (never the offending value). */
export interface IssueSummary {
  path: string;
  message: string;
}

/**
 * Summarize Zod issues as `path: message` pairs. Never includes the input
 * values themselves, so secrets passed by mistake are not echoed into errors
 * or logs.
 */
export function summarizeIssues(error: z.ZodError): IssueSummary[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
  }));
}

/** Render issue summaries as one line, at most `limit` of them. */
export function formatIssues(issues: IssueSummary[], limit = 5): string {
  const shown = issues.slice(0, limit).map((i) => `${i.path}: ${i.message}`);
  if (issues.length > limit) shown.push(`… and ${issues.length - limit} more`);
  return shown.join("; ");
}
