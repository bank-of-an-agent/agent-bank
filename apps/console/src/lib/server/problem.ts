import { NextResponse } from "next/server";

/** RFC 9457 problem details, in the same shape the Agent Bank API returns. */
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export function problem(
  status: number,
  code: string,
  title: string,
  detail?: string,
  extensions: Record<string, unknown> = {},
): NextResponse {
  const body = { ...extensions, type: `urn:agentbank:problem:${code}`, title, status, detail, code };
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": PROBLEM_CONTENT_TYPE, "cache-control": "no-store" },
  });
}

export const problems = {
  unauthorized: () =>
    problem(401, "unauthorized", "Authentication required", "Sign in to the console to continue."),
  staffUnauthorized: () =>
    problem(401, "unauthorized", "Staff sign-in required", "Sign in with an operator token to continue."),
  csrf: (detail: string) => problem(403, "csrf_rejected", "Request blocked", detail),
  sandboxOnly: (detail = "This sign-in method is only available in the sandbox.") =>
    problem(403, "sandbox_only", "Sandbox only", detail),
  notAvailable: (detail = "This API route is not available from the console.") =>
    problem(404, "not_found", "Not found", detail),
  invalid: (detail: string, extensions?: Record<string, unknown>) =>
    problem(400, "invalid_request", "Invalid request", detail, extensions),
  tooLarge: () => problem(413, "invalid_request", "Request too large", "The request body exceeds 1 MB."),
  unsupportedMedia: () =>
    problem(415, "invalid_request", "Unsupported content type", "Send the request body as application/json."),
  misconfigured: (detail: string) => problem(500, "console_misconfigured", "Console misconfigured", detail),
  unreachable: () =>
    problem(502, "api_unreachable", "API unreachable", "The console could not reach the Agent Bank API."),
  timeout: () => problem(504, "api_timeout", "API timeout", "The Agent Bank API did not answer in time."),
};
