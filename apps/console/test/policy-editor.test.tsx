import {
  ownerPayloads,
  PolicyDocumentSchema,
  verifyOwnerAuthorization,
  type OwnerAuthorization,
  type PolicyDocumentInput,
} from "@agentbank/core";
import type { ResponseOf } from "@agentbank/core/api";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyDiffPanel } from "@/components/policy/policy-diff";
import { PolicyEditor } from "@/components/policy/policy-editor";
import { resetApiClient } from "@/lib/api/client";
import { createSandboxKey, forgetSandboxKey } from "@/lib/owner/sandbox-key";
import { diffPolicy } from "@/lib/policy/diff";
import { jsonResponse, renderWithProviders } from "./support/render";

const AGENT = "agt_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const NOW = new Date("2026-10-11T12:00:00Z");

const ORG = {
  id: "org_01J9ZQ3W8K7X5V4T3S2R1Q0P9N",
  object: "org",
  legal_name: "Acme Robotics",
  kind: "company",
  country: "US",
  kyc_status: "approved",
  tier: "pro",
  status: "active",
  owner_address: "0x1111111111111111111111111111111111111111",
  treasury_account_id: null,
  created_at: "2026-10-11T10:00:00.000Z",
};

const rules: PolicyDocumentInput = {
  limits: { per_tx: "25.00", per_day: "200.00" },
  counterparties: { mode: "allowlist", x402_domains: ["api.example-data.com"] },
  approvals: [{ above: "100.00", approvers: 1 }],
};

function agentPolicy(doc: PolicyDocumentInput = rules): ResponseOf<"getPolicy"> {
  return {
    object: "agent_policy",
    agent_id: AGENT,
    current: {
      id: "pol_01J9ZQ3W8K7X5V4T3S2R1Q0P9N",
      object: "policy",
      agent_id: AGENT,
      version: 1,
      rules: PolicyDocumentSchema.parse(doc),
      change_kind: "initial",
      effective_at: "2026-10-11T11:00:00.000Z",
      signed_by: "0x1111111111111111111111111111111111111111",
      created_at: "2026-10-11T11:00:00.000Z",
    },
    pending: null,
  };
}

describe("PolicyDiffPanel", () => {
  it("labels each change and explains the owner key and the 1-hour delay for a mixed change", () => {
    const diff = diffPolicy(rules, { ...rules, limits: { per_tx: "10.00", per_day: "500.00" } }, NOW);
    render(<PolicyDiffPanel diff={diff} />);
    const list = screen.getByRole("list", { name: "Policy changes" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(list).getByText("Tightens")).toBeInTheDocument();
    expect(within(list).getByText("Loosens")).toBeInTheDocument();
    expect(screen.getByText("Per-payment limit")).toBeInTheDocument();
    expect(screen.getByText("Daily limit (rolling 24 h)")).toBeInTheDocument();
    expect(screen.getByText(/Mixed · treated as loosening/)).toBeInTheDocument();
    expect(screen.getByText("Owner key required")).toBeInTheDocument();
    expect(screen.getByText(/takes effect\s+60 minutes later/)).toBeInTheDocument();
  });

  it("says a tightening applies immediately and needs no owner key", () => {
    const diff = diffPolicy(rules, { ...rules, limits: { ...rules.limits, per_day: "100.00" } }, NOW);
    render(<PolicyDiffPanel diff={diff} />);
    expect(screen.getByText("Tightens · applies immediately")).toBeInTheDocument();
    expect(screen.queryByText("Owner key required")).not.toBeInTheDocument();
    expect(screen.getByText("200.00 USDC")).toBeInTheDocument();
    expect(screen.getByText("100.00 USDC")).toBeInTheDocument();
  });
});

describe("PolicyEditor", () => {
  beforeEach(() => {
    resetApiClient();
    document.cookie = "ab_csrf=test-csrf-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/api/v1/orgs/me")
          ? jsonResponse(ORG)
          : jsonResponse({ title: "Not found", status: 404, code: "not_found" }, 404),
      ),
    );
  });

  it("re-labels the live diff as the form changes and saves a tightening without the owner key", async () => {
    const user = userEvent.setup();
    const saved = agentPolicy({ ...rules, limits: { per_tx: "10.00", per_day: "200.00" } });
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      String(input).endsWith("/api/v1/orgs/me") ? jsonResponse(ORG) : jsonResponse(saved),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    renderWithProviders(
      <PolicyEditor agentId={AGENT} agentName="research-bot" policy={agentPolicy()} onSaved={onSaved} />,
    );

    expect(screen.getByRole("button", { name: "Save policy" })).toBeDisabled();

    const perPayment = screen.getByLabelText("Per payment");
    await user.clear(perPayment);
    await user.type(perPayment, "50.00");
    const changes = await screen.findByRole("list", { name: "Policy changes" });
    expect(within(changes).getByText("Loosens")).toBeInTheDocument();
    expect(screen.getByText("Owner key required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign and save…" })).toBeEnabled();

    await user.clear(perPayment);
    await user.type(perPayment, "10.00");
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Policy changes" })).getByText("Tightens"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Owner key required")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ object: "agent_policy" })),
    );

    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put).toBeDefined();
    const [url, init] = put as unknown as [string, RequestInit];
    expect(url).toBe(`http://localhost:3000/api/v1/agents/${AGENT}/policy`);
    const headers = new Headers(init.headers);
    expect(headers.get("x-csrf-token")).toBe("test-csrf-token");
    expect(headers.get("idempotency-key")).toBeTruthy();
    const body = JSON.parse(String(init.body)) as {
      policy: PolicyDocumentInput;
      owner_authorization?: unknown;
    };
    expect(body.policy.limits).toMatchObject({ per_tx: "10.00", per_day: "200.00" });
    expect(body.owner_authorization).toBeUndefined();
  });

  it("shows field errors for invalid amounts and blocks saving", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PolicyEditor agentId={AGENT} agentName="research-bot" policy={agentPolicy()} onSaved={vi.fn()} />,
    );
    const perDay = screen.getByLabelText("Per day");
    await user.clear(perDay);
    await user.type(perDay, "12.3456789");
    expect(await screen.findByText(/1 problem to fix before saving/)).toBeInTheDocument();
    expect(perDay).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save policy" })).toBeDisabled();
  });

  it("validates the JSON view with the policy schema", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PolicyEditor agentId={AGENT} agentName="research-bot" policy={agentPolicy()} onSaved={vi.fn()} />,
    );
    await user.click(screen.getByRole("tab", { name: "JSON" }));
    const editor = screen.getByLabelText("Policy document (JSON)");
    expect((editor as HTMLTextAreaElement).value).toContain('"per_tx": "25.00"');

    fireEvent.change(editor, { target: { value: "{ not json" } });
    expect(await screen.findByText(/JSON syntax error/)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Form" }));
    expect(screen.getByRole("tab", { name: "JSON" })).toHaveAttribute("aria-selected", "true");

    fireEvent.change(editor, { target: { value: JSON.stringify({ limits: { per_tx: 25 } }) } });
    const problems = await screen.findByText(/problem to fix before saving/);
    expect(problems.parentElement).toHaveTextContent("limits.per_tx");

    fireEvent.change(editor, {
      target: { value: JSON.stringify({ ...rules, limits: { per_tx: "500.00", per_day: "200.00" } }) },
    });
    expect((await screen.findAllByText(/Loosens · owner key/)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("tab", { name: "Form" }));
    expect(screen.getByLabelText("Per payment")).toHaveValue("500.00");
  });

  it("signs a loosening with the owner key and sends a verifiable OwnerAuthorization", async () => {
    const user = userEvent.setup();
    const key = createSandboxKey();
    const org = { ...ORG, owner_address: key.address };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/v1/orgs/me")) return jsonResponse(org);
      const body = JSON.parse(String(init?.body)) as { policy: PolicyDocumentInput };
      return jsonResponse(agentPolicy(body.policy));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    renderWithProviders(
      <PolicyEditor agentId={AGENT} agentName="research-bot" policy={agentPolicy()} onSaved={onSaved} />,
    );

    const perPayment = screen.getByLabelText("Per payment");
    await user.clear(perPayment);
    await user.type(perPayment, "75.00");
    await user.click(screen.getByRole("button", { name: "Sign and save…" }));

    const dialog = await screen.findByRole("dialog", { name: "Sign the policy change for research-bot" });
    expect(within(dialog).getByText("You are authorizing")).toBeInTheDocument();
    expect(within(dialog).getAllByText("policy.loosen").length).toBeGreaterThan(0);
    await user.click(within(dialog).getByRole("button", { name: "Use sandbox key" }));
    const sign = within(dialog).getByRole("button", { name: "Sign and save policy" });
    await waitFor(() => expect(sign).toBeEnabled());
    await user.click(sign);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const put = fetchMock.mock.calls.find(([, i]) => i?.method === "PUT");
    const body = JSON.parse(String(put?.[1]?.body)) as {
      policy: PolicyDocumentInput;
      owner_authorization: OwnerAuthorization;
    };
    expect(body.policy.limits).toMatchObject({ per_tx: "75.00" });
    const auth = body.owner_authorization;
    expect(auth.signer).toBe(key.address);
    expect(auth.expires_at - auth.issued_at).toBeLessThanOrEqual(15 * 60);
    // The API verifies exactly this: the canonical payload for policy.loosen on the deployment chain.
    await expect(
      verifyOwnerAuthorization({
        chainId: 84532,
        ...ownerPayloads.policyLoosen(AGENT, body.policy),
        issuedAt: auth.issued_at,
        expiresAt: auth.expires_at,
        owner: key.address,
        signer: auth.signer as `0x${string}`,
        signature: auth.signature as `0x${string}`,
      }),
    ).resolves.toBeUndefined();
    forgetSandboxKey();
  });
});
