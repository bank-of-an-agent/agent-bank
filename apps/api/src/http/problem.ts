import { AgentBankError, isAgentBankError, type ProblemDetails } from "@agentbank/core";
import type { FastifyBaseLogger } from "fastify";
import { ZodError } from "zod";

/** Media type of every error response (RFC 9457). */
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export interface FieldError {
  /** Dotted location of the offending field, e.g. `body.amount.amount`. */
  path: string;
  message: string;
}

/** Turn a ZodError into an `invalid_request` error with field details. */
export function validationError(error: ZodError, location: "params" | "query" | "body"): AgentBankError {
  const errors: FieldError[] = error.issues.map((issue) => ({
    path: [location, ...issue.path.map(String)].join("."),
    message: issue.message,
  }));
  const first = errors[0];
  const detail = first ? `${first.path}: ${first.message}` : "Request validation failed";
  return new AgentBankError("invalid_request", detail, { errors });
}

interface FastifyLikeError {
  code?: unknown;
  statusCode?: unknown;
  message?: unknown;
  validation?: unknown;
}

/**
 * Map any thrown value to an AgentBankError. Unknown errors become `internal` with a generic
 * message (the original is logged, never returned: no stack traces leak to clients).
 */
export function toAgentBankError(error: unknown, log?: FastifyBaseLogger): AgentBankError {
  if (isAgentBankError(error)) return error;
  if (error instanceof ZodError) return validationError(error, "body");
  const e = (error ?? {}) as FastifyLikeError;
  const status = typeof e.statusCode === "number" ? e.statusCode : undefined;
  const code = typeof e.code === "string" ? e.code : "";
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE" || status === 413) {
    return new AgentBankError("invalid_request", "Request body is too large");
  }
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || status === 415) {
    return new AgentBankError("invalid_request", "Unsupported content type; send application/json");
  }
  if (code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
    return new AgentBankError(
      "invalid_request",
      "Body cannot be empty when content-type is application/json",
    );
  }
  if (code.startsWith("FST_ERR_CTP") || (error instanceof SyntaxError && status === 400)) {
    return new AgentBankError("invalid_request", "Malformed JSON body");
  }
  if (status === 429) return new AgentBankError("rate_limited", "Too many requests; slow down");
  if (status === 404) return new AgentBankError("not_found", "Route not found");
  if (status !== undefined && status >= 400 && status < 500) {
    return new AgentBankError("invalid_request", "The request could not be processed");
  }
  log?.error({ err: error }, "unhandled error");
  return new AgentBankError("internal", "An internal error occurred");
}

/** RFC 9457 problem document for an error, with `instance` set to the request path. */
export function problemFor(
  error: unknown,
  instance: string | undefined,
  log?: FastifyBaseLogger,
): ProblemDetails {
  return toAgentBankError(error, log).toProblem(instance);
}
