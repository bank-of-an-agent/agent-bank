import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, apiUrl, consolePost, resetApiClient, setUnauthorizedHandler } from "@/lib/api/client";
import { ApiProblem } from "@/lib/api/problem";
import { jsonResponse } from "./support/render";

const AGENT = "agt_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";

let fetchMock: ReturnType<typeof vi.fn>;

function call(index = -1): { url: string; init: RequestInit; headers: Headers } {
  const entry = fetchMock.mock.calls.at(index);
  if (!entry) throw new Error("fetch was not called");
  const [url, init] = entry as [string, RequestInit];
  return { url: String(url), init, headers: new Headers(init.headers) };
}

beforeEach(() => {
  // Partial fixtures do not match the full response schemas; the client only warns about that.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  resetApiClient();
  document.cookie = "ab_csrf=csrf-from-cookie";
  fetchMock = vi.fn(async () => jsonResponse({ data: [], next_cursor: null }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("browser API client (SDK over the BFF)", () => {
  it("reads through the console origin with cookies and no CSRF header", async () => {
    await apiFetch("listAgents", { query: { limit: 10, status: "frozen" } });
    const { url, init, headers } = call();
    expect(url).toBe("http://localhost:3000/api/v1/agents?limit=10&status=frozen");
    expect(init.credentials).toBe("same-origin");
    expect(headers.get("x-csrf-token")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
  });

  it("sends the double-submit token and an idempotency key on writes", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: AGENT }));
    await apiFetch("freezeAgent", {
      params: { id: AGENT },
      body: { reason: "drill" },
      idempotencyKey: "freeze-0001-abcdef",
    });
    const { url, init, headers } = call();
    expect(url).toBe(`http://localhost:3000/api/v1/agents/${AGENT}/freeze`);
    expect(init.method).toBe("POST");
    expect(headers.get("x-csrf-token")).toBe("csrf-from-cookie");
    expect(headers.get("idempotency-key")).toBe("freeze-0001-abcdef");
    expect(JSON.parse(String(init.body))).toEqual({ reason: "drill" });
  });

  it("validates requests against the route registry before sending", async () => {
    await expect(apiFetch("getAgent", { params: { id: "nope" } })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the code and detail of problem documents, including console-only codes", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          type: "urn:agentbank:problem:csrf_rejected",
          title: "Request blocked",
          status: 403,
          code: "csrf_rejected",
          detail: "Missing CSRF token.",
        },
        403,
      ),
    );
    const error = await apiFetch("freezeOrg", { body: { reason: "x" } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiProblem);
    expect(error).toMatchObject({ status: 403, code: "csrf_rejected", detail: "Missing CSRF token." });
  });

  it("surfaces field errors from invalid_request problems", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          title: "Invalid request",
          status: 400,
          code: "invalid_request",
          detail: "body.name: Too small",
          errors: [{ path: "body.name", message: "Too small" }],
        },
        400,
      ),
    );
    const error = (await apiFetch("createAgent", { body: { name: "x" } }).catch(
      (e: unknown) => e,
    )) as ApiProblem;
    expect(error.errors).toEqual([{ path: "body.name", message: "Too small" }]);
  });

  it("sends the user to sign in when the session is gone", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ title: "Authentication required", status: 401, code: "unauthorized" }, 401),
    );
    await expect(apiFetch("getCurrentOrg")).rejects.toMatchObject({ code: "unauthorized" });
    expect(handler).toHaveBeenCalledWith("getCurrentOrg");
  });

  it("reports network failures as problems", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const error = (await apiFetch("listPlans").catch((e: unknown) => e)) as ApiProblem;
    expect(error).toBeInstanceOf(ApiProblem);
    expect(error.code).toBe("network_error");
  });

  it("builds download URLs for the BFF", () => {
    expect(
      apiUrl("getStatement", {
        query: { account_id: "acct_01J9ZQ3W8K7X5V4T3S2R1Q0P9N", period: "2026-10", format: "csv" },
      }),
    ).toBe("/api/v1/statements?account_id=acct_01J9ZQ3W8K7X5V4T3S2R1Q0P9N&period=2026-10&format=csv");
  });

  it("posts to console auth endpoints with the CSRF token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await consolePost("/api/auth/sign-out");
    const { url, headers } = call();
    expect(url).toBe("/api/auth/sign-out");
    expect(headers.get("x-csrf-token")).toBe("csrf-from-cookie");
  });
});
