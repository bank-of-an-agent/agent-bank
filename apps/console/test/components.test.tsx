import { ownerPayloads, verifyOwnerAuthorization, type OwnerAuthorization } from "@agentbank/core";
import type { ResponseOf } from "@agentbank/core/api";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAddress, recoverMessageAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { OwnerOperationCard } from "@/components/owner/owner-operation";
import { parseNewOwner, RotateOwnerKey } from "@/components/owner/rotate-owner";
import { Countdown } from "@/components/ui/countdown";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { resetApiClient } from "@/lib/api/client";
import { ApiProblem } from "@/lib/api/problem";
import { createSandboxKey, forgetSandboxKey } from "@/lib/owner/sandbox-key";
import { approvalAssertion } from "@/lib/passkey";
import { jsonResponse, renderWithProviders } from "./support/render";

vi.mock("@/lib/passkey", () => ({
  approvalAssertion: vi.fn(async () => ({
    id: "credential-id",
    rawId: "credential-id",
    type: "public-key",
    response: {},
  })),
}));

const AGENT = "agt_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const APPROVAL = "apr_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const PAYMENT = "pay_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const ORG = "org_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";

const agent: ResponseOf<"getAgent"> = {
  id: AGENT,
  object: "agent",
  org_id: ORG,
  name: "research-bot",
  description: null,
  did: null,
  erc8004_id: null,
  agent_card_url: null,
  status: "active",
  frozen_reason: null,
  pending_unfreeze_at: null,
  metadata: {},
  created_at: "2026-10-11T10:00:00.000Z",
};

const AGENTS = new Map([[AGENT, agent]]);

function approval(overrides: Partial<ResponseOf<"getApproval">> = {}): ResponseOf<"getApproval"> {
  return {
    id: APPROVAL,
    object: "approval",
    payment_id: PAYMENT,
    org_id: ORG,
    agent_id: AGENT,
    amount: { amount: "150.00", asset: "USDC" },
    counterparty: {
      type: "x402",
      address: "0x2222222222222222222222222222222222222222",
      agent_id: null,
      x402_domain: "api.example-data.com",
    },
    required_approvers: 1,
    decisions: [],
    status: "pending",
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

const payment = {
  id: PAYMENT,
  memo: "Dataset purchase",
  decision: {
    outcome: "require_approval",
    rule_hits: [
      {
        rule: "approvals",
        effect: "require_approval",
        detail: "150.00 USDC is above the 100.00 USDC threshold (1 approver)",
      },
      { rule: "limits.per_tx", effect: "allow", detail: "within 250.00 USDC" },
    ],
    approvers_required: 1,
    policy_version: 3,
    evaluated_at: "2026-10-11T11:55:00.000Z",
  },
} as unknown as ResponseOf<"getPayment">;

describe("ProblemAlert", () => {
  it("shows the problem code, detail and field errors", () => {
    render(
      <ProblemAlert
        problem={
          new ApiProblem({
            status: 422,
            code: "policy_denied",
            title: "Payment denied by policy",
            detail: "Daily limit exceeded",
            errors: [{ path: "body.amount", message: "Too large" }],
            requestId: "req-123",
          })
        }
      />,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("policy_denied")).toBeInTheDocument();
    expect(within(alert).getByText("Daily limit exceeded")).toBeInTheDocument();
    expect(within(alert).getByText("body.amount")).toBeInTheDocument();
    expect(within(alert).getByText("req-123")).toBeInTheDocument();
    expect(within(alert).getByText("HTTP 422")).toBeInTheDocument();
  });
});

describe("Countdown", () => {
  it("ticks mm:ss with a stable spoken label, then shows expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    render(<Countdown to="2026-10-11T12:01:05Z" />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("1:05");
    expect(timer.getAttribute("aria-label")).toMatch(/^Expires at .+, in about 2 minutes$/);
    act(() => {
      vi.advanceTimersByTime(66_000);
    });
    expect(screen.getByRole("timer")).toHaveTextContent("Expired");
    vi.useRealTimers();
  });

  it("renders an expired timer", () => {
    render(<Countdown to="2000-01-01T00:00:00Z" />);
    expect(screen.getByRole("timer")).toHaveTextContent("Expired");
  });
});

describe("ApprovalCard", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resetApiClient();
    document.cookie = "ab_csrf=test-csrf";
    fetchMock = vi.fn(async () => jsonResponse(approval({ status: "approved" })));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(approvalAssertion).mockClear();
  });

  it("shows amount, counterparty, countdown and the rule hits behind the approval", () => {
    renderWithProviders(
      <ApprovalCard approval={approval()} payment={payment} paymentLoading={false} agents={AGENTS} />,
    );
    const card = screen.getByRole("article");
    expect(within(card).getByRole("heading", { level: 2 })).toHaveTextContent("150.00USDC payment");
    expect(within(card).getByText("research-bot")).toBeInTheDocument();
    expect(within(card).getByText("api.example-data.com")).toBeInTheDocument();
    expect(within(card).getByRole("timer")).toBeInTheDocument();
    expect(within(card).getByText("approvals")).toBeInTheDocument();
    expect(within(card).getByText(/above the 100.00 USDC threshold/)).toBeInTheDocument();
    expect(within(card).getByText("Dataset purchase")).toBeInTheDocument();
  });

  it("approves with a passkey assertion bound to this approval and decision", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ApprovalCard approval={approval()} payment={payment} paymentLoading={false} agents={AGENTS} />,
    );
    await user.click(screen.getByRole("button", { name: "Approve 150.00 USDC payment with passkey" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(approvalAssertion).toHaveBeenCalledWith(APPROVAL, "approve");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://localhost:3000/api/v1/approvals/${APPROVAL}/decide`);
    expect(JSON.parse(String(init.body))).toEqual({
      decision: "approve",
      webauthn_assertion: { id: "credential-id", rawId: "credential-id", type: "public-key", response: {} },
    });
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("test-csrf");
  });

  it("decides without a passkey in a sandbox API-key session", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ApprovalCard approval={approval()} payment={payment} paymentLoading={false} agents={AGENTS} />,
      {
        session: { kind: "api_key", expiresAt: Date.now() / 1000 + 3600 },
      },
    );
    expect(screen.getByText(/Sandbox API-key session/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deny 150.00 USDC payment" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(approvalAssertion).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ decision: "deny" });
  });

  it("shows the API's problem when the decision is refused", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          title: "Approval expired",
          status: 409,
          code: "approval_expired",
          detail: "The approval expired at 12:15",
        },
        409,
      ),
    );
    renderWithProviders(
      <ApprovalCard approval={approval()} payment={payment} paymentLoading={false} agents={AGENTS} />,
    );
    await user.click(screen.getByRole("button", { name: /Approve/ }));
    expect(await screen.findByText("approval_expired")).toBeInTheDocument();
    expect(screen.getByText("The approval expired at 12:15")).toBeInTheDocument();
  });

  it("offers no decision once the approval has expired", () => {
    renderWithProviders(
      <ApprovalCard
        approval={approval({ expires_at: new Date(Date.now() - 1000).toISOString() })}
        payment={payment}
        paymentLoading={false}
        agents={AGENTS}
      />,
    );
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.getByText(/This approval expired/)).toBeInTheDocument();
  });
});

describe("OwnerOperationCard", () => {
  it("signs the raw 32-byte user operation hash (EIP-191) with the owner key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resetApiClient();
    document.cookie = "ab_csrf=test-csrf";
    const user = userEvent.setup();
    const key = createSandboxKey();
    const hash = `0x${"ab".repeat(32)}` as Hex;
    const op = {
      id: "oop_01J9ZQ3W8K7X5V4T3S2R1Q0P9N",
      object: "owner_operation",
      account_id: "acct_01J9ZQ3W8K7X5V4T3S2R1Q0P9N",
      purpose: "session.install",
      subject_id: "ses_01J9ZQ3W8K7X5V4T3S2R1Q0P9N",
      status: "requires_signature",
      user_op_hash: hash,
      chain_id: 84532,
      tx_hash: null,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      created_at: new Date().toISOString(),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/orgs/me")) return jsonResponse({ id: ORG, owner_address: key.address });
      if (init?.method === "POST") return jsonResponse({ ...op, status: "submitted" });
      return jsonResponse(op);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<OwnerOperationCard id={op.id} />);
    expect(await screen.findByText("Install a session key on-chain (Smart Sessions)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use sandbox key" }));
    const sign = screen.getByRole("button", { name: "Sign hash with owner key" });
    await waitFor(() => expect(sign).toBeEnabled());
    await user.click(sign);

    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([, i]) => i?.method === "POST");
    expect(String(post?.[0])).toBe(`http://localhost:3000/api/v1/owner-operations/${op.id}/signature`);
    const { signature } = JSON.parse(String(post?.[1]?.body)) as { signature: Hex };
    await expect(recoverMessageAddress({ message: { raw: hash }, signature })).resolves.toBe(key.address);
    forgetSandboxKey();
  });
});

describe("RotateOwnerKey", () => {
  const org = (owner: string) => ({
    id: ORG,
    object: "org",
    legal_name: "Acme Robotics",
    kind: "company",
    country: "US",
    kyc_status: "approved",
    tier: "pro",
    status: "active",
    owner_address: owner,
    treasury_account_id: null,
    created_at: "2026-10-11T10:00:00.000Z",
  });

  it("rejects malformed, mis-checksummed, zero and unchanged addresses", () => {
    const current = "0x1111111111111111111111111111111111111111";
    expect(parseNewOwner("  ", current)).toEqual({ address: null, error: null });
    expect(parseNewOwner("0x1234", current).error).toMatch(/40 hex characters/);
    expect(parseNewOwner("0x52908400098527886e0F7030069857D2E4169EE7", current).error).toMatch(/checksum/);
    expect(parseNewOwner(`0x${"0".repeat(40)}`, current).error).toMatch(/zero address/);
    expect(parseNewOwner(current, current).error).toBe("That is already the owner key.");
    const lower = "0xde709f2102306220921060314715629080e2fb77";
    expect(parseNewOwner(` ${lower} `, current)).toEqual({ address: getAddress(lower), error: null });
  });

  it("signs owner.rotate with the current owner key and sends the checksummed new address", async () => {
    // Start without a remembered signer choice from earlier tests.
    localStorage.clear();
    resetApiClient();
    document.cookie = "ab_csrf=test-csrf";
    const user = userEvent.setup();
    const key = createSandboxKey();
    const next = privateKeyToAccount(generatePrivateKey()).address;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { new_owner_address: string };
        return jsonResponse(org(body.new_owner_address));
      }
      return jsonResponse(org(key.address));
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<RotateOwnerKey />);
    await user.click(await screen.findByRole("button", { name: "Rotate owner key…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rotate the owner key" });
    const field = within(dialog).getByLabelText(/New owner address/);
    await user.type(field, key.address);
    expect(within(dialog).getByText("That is already the owner key.")).toBeInTheDocument();
    expect(within(dialog).queryByText("You are authorizing")).not.toBeInTheDocument();

    await user.clear(field);
    await user.type(field, next.toLowerCase());
    expect(within(dialog).getAllByText("owner.rotate").length).toBeGreaterThan(0);
    await user.click(within(dialog).getByRole("button", { name: "Use sandbox key" }));
    const sign = within(dialog).getByRole("button", { name: "Sign and rotate" });
    await waitFor(() => expect(sign).toBeEnabled());
    await user.click(sign);

    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([, i]) => i?.method === "POST");
    expect(String(post?.[0])).toBe("http://localhost:3000/api/v1/orgs/me/owner");
    const body = JSON.parse(String(post?.[1]?.body)) as {
      new_owner_address: string;
      owner_authorization: OwnerAuthorization;
    };
    expect(body.new_owner_address).toBe(next);
    const auth = body.owner_authorization;
    // What the API verifies: the canonical owner.rotate payload, signed by the CURRENT owner.
    await expect(
      verifyOwnerAuthorization({
        chainId: 84532,
        ...ownerPayloads.ownerRotate(ORG, body.new_owner_address),
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
