import { AgentBankError, ConnectionError, PolicyDeniedError, TimeoutError, X402Error } from "@agentbank/sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool errors: `isError: true` results whose text is
 * `{"error":{"code","detail",…}}`. `code` is the API's problem code (or
 * `network_error` / `timeout` for transport failures, `invalid_request` for
 * bad tool input). Stack traces, request internals and secrets never appear;
 * unexpected errors are reported as a generic `internal` error.
 *
 * @packageDocumentation
 */

/** Machine-readable error returned to the model. */
export interface ToolErrorBody {
  code: string;
  detail: string;
  [field: string]: unknown;
}

/** Describe an error for the model. */
export function describeError(error: unknown): ToolErrorBody {
  if (error instanceof X402Error) {
    return { code: error.code, detail: error.message, reason: error.reason };
  }
  if (error instanceof PolicyDeniedError) {
    const hits = error.decision?.rule_hits.filter((h) => h.effect !== "info" && h.effect !== "allow");
    return {
      code: error.code,
      detail: error.message,
      ...(hits && hits.length > 0
        ? { rule_hits: hits.map((h) => ({ rule: h.rule, detail: h.detail })) }
        : {}),
    };
  }
  if (error instanceof TimeoutError) {
    return {
      code: "timeout",
      detail: "Agent Bank did not answer in time. Retry with the same idempotency_key to avoid paying twice.",
    };
  }
  if (error instanceof ConnectionError) {
    return { code: "network_error", detail: "Could not reach Agent Bank. Try again later." };
  }
  if (error instanceof AgentBankError) {
    return { code: error.code, detail: error.message };
  }
  return { code: "internal", detail: "Unexpected error while handling the request." };
}

/** Build an MCP tool error result. */
export function toolError(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: describeError(error) }) }],
  };
}

/** Build a tool error from a code and detail (for input problems detected by the tool itself). */
export function toolInputError(detail: string): CallToolResult {
  return toolError(new InputError(detail));
}

class InputError extends AgentBankError {
  constructor(detail: string) {
    super("invalid_request", detail);
  }
}
