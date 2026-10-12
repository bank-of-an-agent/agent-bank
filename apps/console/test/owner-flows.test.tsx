import { ownerPayloads, verifyOwnerAuthorization, type OwnerAuthorization } from "@agentbank/core";
import { signSpendKeyPermit, spendKeyPermitTypedData } from "@agentbank/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { recoverMessageAddress, recoverTypedDataAddress, verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionsCard } from "@/components/agents/sessions-card";
import { SpendKeyDetail } from "@/components/agents/spend-key";
import { OwnerOperationsPage } from "@/components/pages/owner-operations";
import { VaultsCard } from "@/components/treasury/vaults";
import { resetApiClient } from "@/lib/api/client";
import type { Account, Agent } from "@/lib/api/queries";
import { downloadText } from "@/lib/download";
import { createSandboxKey, forgetSandboxKey } from "@/lib/owner/sandbox-key";
import { checkPermit } from "@/lib/owner/spend-key";
import { earlyWithdrawalTypedData, EARLY_WITHDRAWAL_TYPES } from "@/lib/owner/vault-withdrawal";
import { jsonResponse, renderWithProviders, testConfig } from "./support/render";

vi.mock("@/lib/download", () => ({ downloadText: vi.fn() }));

const ORG = "org_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const AGENT = "agt_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const ACCOUNT = "acct_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const SESSION = "ses_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const OP = "oop_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const VAULT = "vlt_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const VAULTS_CONTRACT = "0x4444444444444444444444444444444444444444";
const USDC = testConfig.usdc as { address: string; name: string; version: string };

const agent: Agent = {
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

const account: Account = {
  id: ACCOUNT,
  object: "account",
  agent_id: AGENT,
  org_id: ORG,
  role: "agent",
  chain: "base-sepolia",
  chain_id: 84532,
  address: "0x3333333333333333333333333333333333333333",
  deployed: false,
  owner_address: "0x1111111111111111111111111111111111111111",
  spend_key_address: null,
  spend_key_permit: "none",
  module_versions: {},
  created_at: "2026-10-11T10:00:00.000Z",
};

function org(owner: string) {
  return {
    id: ORG,
    object: "org",
    legal_name: "Acme Robotics",
    kind: "company",
    country: "US",
    kyc_status: "approved",
    tier: "pro",
    status: "active",
    frozen_reason: null,
    pending_unfreeze_at: null,
    owner_address: owner,
    treasury_account_id: null,
    created_at: "2026-10-11T10:00:00.000Z",
  };
}

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: OP,
    object: "owner_operation",
    account_id: ACCOUNT,
    purpose: "session.install",
    subject_id: SESSION,
    status: "requires_signature",
    user_op_hash: `0x${"ab".repeat(32)}`,
    chain_id: 84532,
    tx_hash: null,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const page = (data: unknown[]) => ({ data, next_cursor: null });

type Route = (path: string, method: string, init: RequestInit | undefined, url: URL) => Response | undefined;

/** A fetch mock that routes by path; unknown paths are 404 problems. */
function routes(handler: Route) {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api/, "");
    return (
      handler(path, init?.method ?? "GET", init, url) ??
      jsonResponse({ title: "Not found", status: 404, code: "not_found" }, 404)
    );
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function bodyOf(mock: ReturnType<typeof routes>, path: string, method = "POST"): unknown {
  const call = mock.mock.calls.find(([u, i]) => String(u).endsWith(path) && (i?.method ?? "GET") === method);
  return call ? JSON.parse(String(call[1]?.body)) : undefined;
}

beforeEach(() => {
  localStorage.clear();
  resetApiClient();
  document.cookie = "ab_csrf=test-csrf";
  vi.mocked(downloadText).mockClear();
});

describe("early vault withdrawal typed data", () => {
  const now = 1_800_000_000;
  const described = {
    domain: {
      name: "AgentBank TimeLockVaults",
      version: "1",
      chainId: 84532,
      verifyingContract: VAULTS_CONTRACT,
    },
    types: EARLY_WITHDRAWAL_TYPES,
    primaryType: "EarlyWithdrawal",
    message: { vaultId: "7", amount: "250000000", nonce: "2", deadline: String(now + 900) },
  };
  const expected = {
    chainId: 84532,
    contract: VAULTS_CONTRACT,
    onchainId: "7",
    amountMinor: 250_000_000n,
    now,
  };

  it("accepts exactly the withdrawal the owner asked for", () => {
    const result = earlyWithdrawalTypedData(described, expected);
    expect(result.ok && result.typedData.message).toEqual({
      vaultId: 7n,
      amount: 250_000_000n,
      nonce: 2n,
      deadline: BigInt(now + 900),
    });
  });

  it.each([
    [
      "another contract",
      { ...described, domain: { ...described.domain, verifyingContract: `0x${"5".repeat(40)}` } },
    ],
    ["another chain", { ...described, domain: { ...described.domain, chainId: 8453 } }],
    ["another domain", { ...described, domain: { ...described.domain, name: "USDC" } }],
    ["another vault", { ...described, message: { ...described.message, vaultId: "8" } }],
    ["a larger amount", { ...described, message: { ...described.message, amount: "250000001" } }],
    ["a far deadline", { ...described, message: { ...described.message, deadline: String(now + 86_400) } }],
    ["a past deadline", { ...described, message: { ...described.message, deadline: String(now - 1) } }],
    ["another primary type", { ...described, primaryType: "Permit" }],
  ])("refuses %s", (_label, value) => {
    expect(earlyWithdrawalTypedData(value, expected).ok).toBe(false);
  });
});

describe("spend-key permits", () => {
  const target = { account: account.address, chainId: 84532, usdc: USDC };

  it("verifies a permit the agent's runtime signed and rejects one for another account", async () => {
    const spendKey = privateKeyToAccount(generatePrivateKey());
    const permit = await signSpendKeyPermit({
      spendKey,
      account: account.address,
      chainId: 84532,
      usdc: USDC.address,
      name: USDC.name,
      version: USDC.version,
    });
    const ok = await checkPermit(JSON.stringify(permit), spendKey.address, target);
    expect(ok).toEqual({ ok: true, permit });
    const wrongAccount = await checkPermit(JSON.stringify(permit), spendKey.address, {
      ...target,
      account: `0x${"6".repeat(40)}`,
    });
    expect(wrongAccount.ok).toBe(false);
    expect((await checkPermit("{", spendKey.address, target)).ok).toBe(false);
  });

  it("generates a testnet key in the browser, requires the download, then attaches it with both signatures", async () => {
    const user = userEvent.setup();
    const owner = createSandboxKey();
    const mock = routes((path, method) => {
      if (path === "/v1/orgs/me") return jsonResponse(org(owner.address));
      if (method === "PUT" && path === `/v1/accounts/${ACCOUNT}/spend-key`) {
        return jsonResponse({ ...account, spend_key_permit: "pending" });
      }
      return undefined;
    });

    renderWithProviders(<SpendKeyDetail account={account} agentName="research-bot" />);
    await user.click(screen.getByRole("button", { name: "Attach spend key…" }));
    const dialog = await screen.findByRole("dialog", { name: "Attach an x402 spend key to research-bot" });
    expect(within(dialog).getByText(/Testnet only/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Generate testnet spend key" }));
    await user.click(within(dialog).getByRole("button", { name: "Use sandbox key" }));

    const attach = within(dialog).getByRole("button", { name: "Sign and attach" });
    expect(attach).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Download key file" }));
    expect(downloadText).toHaveBeenCalledTimes(1);
    const [filename, text] = vi.mocked(downloadText).mock.calls[0] as [string, string];
    expect(filename).toMatch(/^agentbank-spend-key-research-bot-[0-9a-f]{6}\.testnet\.json$/);
    const file = JSON.parse(text) as {
      private_key: Hex;
      address: string;
      testnet_only: boolean;
      warning: string;
    };
    expect(file.testnet_only).toBe(true);
    expect(file.warning).toMatch(/^TESTNET ONLY/);
    expect(privateKeyToAccount(file.private_key).address).toBe(file.address);
    expect(attach).toBeDisabled();
    await user.click(within(dialog).getByLabelText(/I saved the key file/));
    await waitFor(() => expect(attach).toBeEnabled());
    await user.click(attach);
    await waitFor(() => expect(bodyOf(mock, `/v1/accounts/${ACCOUNT}/spend-key`, "PUT")).toBeDefined());

    const body = bodyOf(mock, `/v1/accounts/${ACCOUNT}/spend-key`, "PUT") as {
      spend_key_address: string;
      permit: { value: string; deadline: string; nonce: string; signature: Hex };
      owner_authorization: OwnerAuthorization;
    };
    expect(body.spend_key_address).toBe(file.address);
    // The spend key signed the float-recovery permit for the account's address ...
    const permitData = spendKeyPermitTypedData({
      owner: body.spend_key_address,
      account: account.address,
      chainId: 84532,
      usdc: USDC.address,
      name: USDC.name,
      version: USDC.version,
      value: body.permit.value,
      deadline: body.permit.deadline,
      nonce: body.permit.nonce,
    });
    await expect(
      verifyTypedData({ ...permitData, address: file.address as Hex, signature: body.permit.signature }),
    ).resolves.toBe(true);
    // ... and the owner key signed spend_key.set over the same address.
    const auth = body.owner_authorization;
    await expect(
      verifyOwnerAuthorization({
        chainId: 84532,
        ...ownerPayloads.spendKeySet(ACCOUNT, body.spend_key_address),
        issuedAt: auth.issued_at,
        expiresAt: auth.expires_at,
        owner: owner.address,
        signer: auth.signer as Hex,
        signature: auth.signature as Hex,
      }),
    ).resolves.toBeUndefined();
    // The spend key's private key never leaves the browser.
    for (const [, init] of mock.mock.calls)
      expect(String(init?.body ?? "")).not.toContain(file.private_key.slice(2));
    forgetSandboxKey();
  });

  it("shows the permit status of an attached key", () => {
    renderWithProviders(
      <SpendKeyDetail
        account={{ ...account, spend_key_address: `0x${"7".repeat(40)}`, spend_key_permit: "pending" }}
        agentName="research-bot"
      />,
    );
    expect(screen.getByText("Permit pending")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach spend key…" })).not.toBeInTheDocument();
  });
});

describe("owner operations inbox", () => {
  it("lists what waits for the owner key and signs the raw hash", async () => {
    const user = userEvent.setup();
    const owner = createSandboxKey();
    const mock = routes((path, method, _init, url) => {
      if (path === "/v1/orgs/me") return jsonResponse(org(owner.address));
      if (path === "/v1/accounts") return jsonResponse(page([account]));
      if (path === "/v1/agents") return jsonResponse(page([agent]));
      if (path === "/v1/owner-operations" && url.searchParams.get("status") === "requires_signature") {
        return jsonResponse(page([operation()]));
      }
      if (method === "POST" && path === `/v1/owner-operations/${OP}/signature`) {
        return jsonResponse(operation({ status: "submitted" }));
      }
      return undefined;
    });

    renderWithProviders(<OwnerOperationsPage />);
    expect(await screen.findByText("Install a session key on-chain (Smart Sessions)")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Waiting for signature (1)" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("link", { name: /ses_01J9/ })).toHaveAttribute(
      "href",
      `/agents/${AGENT}#sessions`,
    );
    await user.click(screen.getByRole("button", { name: "Use sandbox key" }));
    const sign = screen.getByRole("button", { name: /^Sign install a session key/ });
    await waitFor(() => expect(sign).toBeEnabled());
    await user.click(sign);
    await waitFor(() => expect(bodyOf(mock, `/v1/owner-operations/${OP}/signature`)).toBeDefined());
    const { signature } = bodyOf(mock, `/v1/owner-operations/${OP}/signature`) as { signature: Hex };
    await expect(
      recoverMessageAddress({ message: { raw: `0x${"ab".repeat(32)}` }, signature }),
    ).resolves.toBe(owner.address);
    const call = mock.mock.calls.find(([u]) => String(u).endsWith(`/owner-operations/${OP}/signature`));
    expect(new Headers(call?.[1]?.headers).get("idempotency-key")).toMatch(
      new RegExp(`^oop_sig_${OP}_[0-9a-f]{16}$`),
    );
    forgetSandboxKey();
  });

  it("says when nothing waits", async () => {
    routes((path) => {
      if (path === "/v1/owner-operations") return jsonResponse(page([]));
      if (path === "/v1/orgs/me") return jsonResponse(org(account.owner_address));
      if (path === "/v1/accounts" || path === "/v1/agents") return jsonResponse(page([]));
      return undefined;
    });
    renderWithProviders(<OwnerOperationsPage />);
    expect(await screen.findByText("Nothing to sign")).toBeInTheDocument();
  });
});

describe("sessions", () => {
  it("lists the agent's sessions from the API and signs the on-chain revoke after revoking", async () => {
    const user = userEvent.setup();
    const owner = createSandboxKey();
    const session = {
      id: SESSION,
      object: "session",
      account_id: ACCOUNT,
      public_key: `0x${"8".repeat(40)}`,
      scope: {
        asset: "USDC",
        max_per_tx: "25.00",
        max_per_day: "200.00",
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
      status: "active",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      revoked_at: null,
      onchain_tx: null,
      install_operation_id: null,
      revoke_operation_id: null,
      created_at: new Date().toISOString(),
    };
    const revokeOp = operation({ purpose: "session.revoke" });
    const mock = routes((path, method, _init, url) => {
      if (path === "/v1/orgs/me") return jsonResponse(org(owner.address));
      if (path === "/v1/sessions" && url.searchParams.get("agent_id") === AGENT)
        return jsonResponse(page([session]));
      if (method === "DELETE" && path === `/v1/sessions/${SESSION}`) {
        return jsonResponse({
          ...session,
          status: "revoked",
          revoked_at: new Date().toISOString(),
          revoke_operation_id: OP,
        });
      }
      if (path === "/v1/owner-operations") return jsonResponse(page([revokeOp]));
      if (path === `/v1/owner-operations/${OP}`) return jsonResponse(revokeOp);
      return undefined;
    });

    renderWithProviders(<SessionsCard agent={agent} accounts={[account]} />);
    expect(await screen.findByText("Active")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke the session on-chain" });
    expect(
      await within(dialog).findByText("Revoke a session key on-chain (the hard backstop)"),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Sign hash with owner key" })).toBeInTheDocument();
    expect(
      mock.mock.calls.some(([u, i]) => String(u).endsWith(`/sessions/${SESSION}`) && i?.method === "DELETE"),
    ).toBe(true);
    forgetSandboxKey();
  });
});

describe("locked vault early withdrawal", () => {
  it("signs TimeLockVaults' EarlyWithdrawal, then hands the owner operation to the owner key", async () => {
    const user = userEvent.setup();
    const owner = createSandboxKey();
    const vault = {
      id: VAULT,
      object: "vault",
      account_id: ACCOUNT,
      kind: "locked",
      name: "Q1 reserve",
      target: null,
      unlock_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      balance: { amount: "5000.00", asset: "USDC" },
      contract_address: VAULTS_CONTRACT,
      onchain_id: "7",
      pending_operation_id: null,
      created_at: new Date().toISOString(),
    };
    const deadline = Math.floor(Date.now() / 1000) + 900;
    const withdrawOp = operation({ purpose: "vault.withdraw", subject_id: VAULT });
    const mock = routes((path, method, init) => {
      if (path === "/v1/orgs/me") return jsonResponse(org(owner.address));
      if (path === "/v1/vaults") return jsonResponse(page([vault]));
      if (path === "/v1/accounts") return jsonResponse(page([account]));
      if (path === "/v1/agents") return jsonResponse(page([agent]));
      if (path === "/v1/owner-operations") return jsonResponse(page([]));
      if (path === `/v1/owner-operations/${OP}`) return jsonResponse(withdrawOp);
      if (method === "POST" && path === `/v1/vaults/${VAULT}/withdraw`) {
        const body = JSON.parse(String(init?.body)) as { owner_authorization?: unknown };
        if (!body.owner_authorization) {
          return jsonResponse(
            {
              title: "Owner signature required",
              status: 403,
              code: "owner_signature_required",
              detail: "Early withdrawal needs the owner's TimeLockVaults EarlyWithdrawal signature",
              typed_data: {
                domain: {
                  name: "AgentBank TimeLockVaults",
                  version: "1",
                  chainId: 84532,
                  verifyingContract: VAULTS_CONTRACT,
                },
                types: EARLY_WITHDRAWAL_TYPES,
                primaryType: "EarlyWithdrawal",
                message: { vaultId: "7", amount: "250000000", nonce: "0", deadline: String(deadline) },
              },
            },
            403,
          );
        }
        return jsonResponse({ ...vault, pending_operation_id: OP });
      }
      return undefined;
    });

    renderWithProviders(<VaultsCard />);
    await user.click(await screen.findByRole("button", { name: "Withdraw" }));
    const dialog = await screen.findByRole("dialog", { name: "Withdraw from Q1 reserve" });
    await user.type(within(dialog).getByLabelText(/Amount/), "250.00");
    await user.click(within(dialog).getByRole("button", { name: "Withdraw" }));
    expect(
      await within(dialog).findByText("You are signing a TimeLockVaults early withdrawal"),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Use sandbox key" }));
    const sign = within(dialog).getByRole("button", { name: "Sign early withdrawal" });
    await waitFor(() => expect(sign).toBeEnabled());
    await user.click(sign);
    expect(await within(dialog).findByText("Withdraw early from a locked vault")).toBeInTheDocument();

    const signed = mock.mock.calls
      .filter(([u, i]) => String(u).endsWith(`/vaults/${VAULT}/withdraw`) && i?.method === "POST")
      .map(([, i]) => JSON.parse(String(i?.body)) as { owner_authorization?: OwnerAuthorization })
      .find((b) => b.owner_authorization);
    const auth = signed?.owner_authorization as OwnerAuthorization;
    expect(auth.expires_at).toBe(deadline);
    await expect(
      recoverTypedDataAddress({
        domain: {
          name: "AgentBank TimeLockVaults",
          version: "1",
          chainId: 84532,
          verifyingContract: VAULTS_CONTRACT,
        },
        types: EARLY_WITHDRAWAL_TYPES,
        primaryType: "EarlyWithdrawal",
        message: { vaultId: 7n, amount: 250_000_000n, nonce: 0n, deadline: BigInt(deadline) },
        signature: auth.signature as Hex,
      }),
    ).resolves.toBe(owner.address);
    forgetSandboxKey();
  });
});
