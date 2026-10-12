import { ownerPayloads, verifyOwnerAuthorization, type OwnerAuthorization } from "@agentbank/core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivateProofsCard, ProofRootsCard } from "@/components/agents/private-proofs-card";
import { resetApiClient } from "@/lib/api/client";
import type { Account, Agent } from "@/lib/api/queries";
import { createSandboxKey, forgetSandboxKey } from "@/lib/owner/sandbox-key";
import { classifyDisclosureChange } from "@/lib/proofs";
import { jsonResponse, renderWithProviders, testConfig } from "./support/render";

const ORG = "org_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const AGENT = "agt_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const ACCOUNT = "acct_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const RESERVATION = "prv_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const HOLD = "hold_01J9ZQ3W8K7X5V4T3S2R1Q0P9N";
const ROOT = `0x${"1a".repeat(32)}`;

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
  deployed: true,
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

const MASKS: Record<string, number> = {
  principal: 1,
  limits: 6,
  balance: 8,
  reservations: 112,
  account_age: 128,
  reputation: 7936,
};

function settings(enabled: boolean, disclose: string[]) {
  return {
    object: "proof_settings",
    agent_id: AGENT,
    enabled,
    disclose,
    disclosure_mask: disclose.reduce((mask, c) => mask | (MASKS[c] ?? 0), 0),
    updated_at: enabled || disclose.length ? "2026-10-11T12:00:00.000Z" : null,
  };
}

function root(overrides: Record<string, unknown> = {}) {
  return {
    object: "proof_root",
    root: ROOT,
    epoch: "42",
    snapshot_at: new Date(Date.now() - 60_000).toISOString(),
    published_at: new Date(Date.now() - 30_000).toISOString(),
    valid_until: new Date(Date.now() + 7_200_000).toISOString(),
    leaf_count: 3,
    status: "published",
    tx_hash: `0x${"2b".repeat(32)}`,
    chain_id: 84532,
    registry: "0x5555555555555555555555555555555555555555",
    ...overrides,
  };
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: RESERVATION,
    object: "proof_reservation",
    account_id: ACCOUNT,
    agent_id: AGENT,
    amount: { amount: "500.00", asset: "USDC" },
    scope_tag: "1234567890123456789",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    status: "active",
    hold_id: HOLD,
    created_at: new Date(Date.now() - 600_000).toISOString(),
    released_at: null,
    included_in_epoch: "41",
    ...overrides,
  };
}

const identity = {
  object: "proof_identity",
  account_id: ACCOUNT,
  identity_commitment: `0x${"0c".repeat(32)}`,
  created_at: "2026-10-11T12:30:00.000Z",
  updated_at: "2026-10-11T12:30:00.000Z",
};

const notEnrolled = jsonResponse(
  {
    title: "Not found",
    status: 404,
    code: "not_found",
    detail: "No identity commitment is enrolled for this account",
    reason: "not_enrolled",
  },
  404,
);

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

function bodiesOf(mock: ReturnType<typeof routes>, path: string, method: string): Record<string, unknown>[] {
  return mock.mock.calls
    .filter(([u, i]) => new URL(String(u)).pathname.endsWith(path) && (i?.method ?? "GET") === method)
    .map(([, i]) => JSON.parse(String(i?.body)) as Record<string, unknown>);
}

const SETTINGS_PATH = `/v1/agents/${AGENT}/proofs/settings`;

/** The API behind the card: settings (mutable through PUT), identity, roots and reservations. */
function proofsApi(options: {
  owner: string;
  settings: ReturnType<typeof settings>;
  enrolled?: boolean;
  reservations?: ReturnType<typeof reservation>[];
  put?: (body: Record<string, unknown>) => Response | undefined;
}) {
  let current = options.settings;
  return routes((path, method, init, url) => {
    if (path === "/v1/orgs/me") return jsonResponse(org(options.owner));
    if (path === SETTINGS_PATH && method === "GET") return jsonResponse(current);
    if (path === SETTINGS_PATH && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { enabled: boolean; disclose: string[] };
      const custom = options.put?.(body);
      if (custom) return custom;
      current = settings(body.enabled, body.disclose);
      return jsonResponse(current);
    }
    if (path === `/v1/accounts/${ACCOUNT}/proofs/identity`) {
      return options.enrolled ? jsonResponse(identity) : notEnrolled.clone();
    }
    if (path === "/v1/proofs/roots") return jsonResponse(page([root()]));
    if (path === `/v1/accounts/${ACCOUNT}/proofs/reservations`) {
      const status = url.searchParams.get("status");
      return jsonResponse(page((options.reservations ?? []).filter((r) => r.status === status)));
    }
    if (method === "POST" && path === `/v1/proofs/reservations/${RESERVATION}/release`) {
      return jsonResponse(reservation({ status: "released", released_at: new Date().toISOString() }));
    }
    return undefined;
  });
}

async function expectOwnerSigned(
  auth: OwnerAuthorization,
  owner: string,
  request: ReturnType<typeof ownerPayloads.proofsDisclose | typeof ownerPayloads.proofReservationRelease>,
) {
  await expect(
    verifyOwnerAuthorization({
      chainId: 84532,
      ...request,
      issuedAt: auth.issued_at,
      expiresAt: auth.expires_at,
      owner: owner as Hex,
      signer: auth.signer as Hex,
      signature: auth.signature as Hex,
    }),
  ).resolves.toBeUndefined();
}

beforeEach(() => {
  localStorage.clear();
  resetApiClient();
  document.cookie = "ab_csrf=test-csrf";
});

afterEach(() => {
  forgetSandboxKey();
});

describe("disclosure change classification", () => {
  it("mirrors the API: enabling and adding widen, disabling and removing narrow", () => {
    const on = { enabled: true, disclose: ["principal", "balance"] };
    expect(classifyDisclosureChange(on, { enabled: true, disclose: ["balance", "principal"] })).toMatchObject(
      {
        changed: false,
        widening: false,
        narrowing: false,
      },
    );
    expect(
      classifyDisclosureChange(on, { enabled: true, disclose: ["principal", "balance", "reputation"] }),
    ).toMatchObject({ widening: true, narrowing: false, added: ["reputation"] });
    expect(classifyDisclosureChange(on, { enabled: true, disclose: ["principal"] })).toMatchObject({
      widening: false,
      narrowing: true,
      removed: ["balance"],
    });
    expect(classifyDisclosureChange(on, { enabled: false, disclose: on.disclose })).toMatchObject({
      widening: false,
      narrowing: true,
    });
    // Swapping one class for another widens (owner signature) and narrows (older roots revoked).
    expect(classifyDisclosureChange(on, { enabled: true, disclose: ["principal", "limits"] })).toMatchObject({
      widening: true,
      narrowing: true,
      next: ["principal", "limits"],
    });
    const off = { enabled: false, disclose: ["balance"] };
    expect(classifyDisclosureChange(off, { enabled: true, disclose: ["balance"] }).widening).toBe(true);
    expect(classifyDisclosureChange(off, { enabled: false, disclose: ["balance", "limits"] }).widening).toBe(
      true,
    );
    // Removing a class while proofs are off neither widens nor narrows anything provable.
    expect(classifyDisclosureChange(off, { enabled: false, disclose: [] })).toMatchObject({
      changed: true,
      widening: false,
      narrowing: false,
    });
  });
});

describe("PrivateProofsCard", () => {
  it("shows the settings, every class, a not-enrolled identity, the latest root and open reservations", async () => {
    proofsApi({
      owner: account.owner_address,
      settings: settings(true, ["principal", "balance"]),
      reservations: [reservation(), reservation({ status: "released" })],
    });
    renderWithProviders(<PrivateProofsCard agent={agent} accounts={[account]} />);

    const card = screen.getByRole("region", { name: "Private proofs" });
    expect(await within(card).findByText("Enabled")).toBeInTheDocument();
    expect(within(card).getByText("Testnet only")).toBeInTheDocument();
    expect(within(card).getByText(/trust Agent Bank as the attester/)).toBeInTheDocument();

    const classes = within(card).getByRole("region", { name: "What it may prove" });
    const items = within(classes).getAllByRole("listitem");
    expect(items).toHaveLength(6);
    for (const label of [
      "Principal",
      "Spending limits",
      "Balance",
      "Reservations",
      "Account age",
      "Reputation",
    ])
      expect(within(classes).getByText(label)).toBeInTheDocument();
    expect(within(classes).getAllByText("Disclosed")).toHaveLength(2);
    expect(within(classes).getAllByText("Not disclosed")).toHaveLength(4);
    expect(within(classes).getByText(/never which one/)).toBeInTheDocument();

    const identitySection = within(card).getByRole("region", { name: "Identity" });
    expect(await within(identitySection).findByText("Not enrolled")).toBeInTheDocument();
    expect(within(identitySection).queryByRole("alert")).not.toBeInTheDocument();

    const rootSection = within(card).getByRole("region", { name: "Latest root" });
    expect(await within(rootSection).findByText("42")).toBeInTheDocument();
    expect(within(rootSection).getByText("Published")).toBeInTheDocument();
    expect(within(rootSection).getByText("3 agents in the tree")).toBeInTheDocument();
    expect(within(rootSection).getByText(/Fewer than 16 agents/)).toBeInTheDocument();

    const table = await within(card).findByRole("region", { name: "Open proof-of-funds reservations" });
    const rows = within(table).getAllByRole("row");
    // Header plus the active reservation; the released one is not open.
    expect(rows).toHaveLength(2);
    expect(within(table).getByText("500.00")).toBeInTheDocument();
    expect(within(table).getByText("1234567890123456789")).toBeInTheDocument();
    expect(within(table).getByText("Active")).toBeInTheDocument();
    expect(
      within(table).getByRole("button", { name: "Release early… the 500.00 USDC reservation" }),
    ).toBeInTheDocument();
  });

  it("shows a disabled agent with an enrolled identity and offers to turn proofs on", async () => {
    proofsApi({ owner: account.owner_address, settings: settings(false, []), enrolled: true });
    renderWithProviders(<PrivateProofsCard agent={agent} accounts={[account]} />);
    expect(await screen.findByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText(/cannot prove anything/)).toBeInTheDocument();
    expect(await screen.findByText("Enrolled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn on…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn off" })).not.toBeInTheDocument();
    expect(await screen.findByText("No open reservations")).toBeInTheDocument();
  });

  it("is hidden when the deployment turns private proofs off", () => {
    const mock = routes(() => undefined);
    renderWithProviders(<PrivateProofsCard agent={agent} accounts={[account]} />, {
      config: { ...testConfig, features: { private_proofs: false } },
    });
    expect(screen.queryByRole("region", { name: "Private proofs" })).not.toBeInTheDocument();
    expect(mock).not.toHaveBeenCalled();
  });

  it("asks for the owner key to disclose another class and sends a proofs.disclose authorization", async () => {
    const user = userEvent.setup();
    const owner = createSandboxKey();
    const mock = proofsApi({ owner: owner.address, settings: settings(true, ["principal", "balance"]) });
    renderWithProviders(<PrivateProofsCard agent={agent} accounts={[account]} />);

    await user.click(await screen.findByRole("button", { name: "Edit disclosure…" }));
    const editor = await screen.findByRole("dialog", { name: "What research-bot may prove" });
    await user.click(within(editor).getByRole("checkbox", { name: "Reputation" }));
    expect(within(editor).getByText("Widening needs the owner key")).toBeInTheDocument();
    await user.click(within(editor).getByRole("button", { name: "Continue to owner signature…" }));

    const dialog = await screen.findByRole("dialog", { name: "Widen what research-bot may prove" });
    expect(within(dialog).getByText("Disclose Reputation")).toBeInTheDocument();
    expect(within(dialog).getByText("proofs.disclose")).toBeInTheDocument();
    // Nothing is sent before the owner signs.
    expect(bodiesOf(mock, SETTINGS_PATH, "PUT")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Use sandbox key" }));
    const sign = within(dialog).getByRole("button", { name: "Sign and save" });
    await waitFor(() => expect(sign).toBeEnabled());
    await user.click(sign);

    await waitFor(() => expect(bodiesOf(mock, SETTINGS_PATH, "PUT")).toHaveLength(1));
    const [body] = bodiesOf(mock, SETTINGS_PATH, "PUT") as {
      enabled: boolean;
      disclose: string[];
      owner_authorization: OwnerAuthorization;
    }[];
    expect(body?.enabled).toBe(true);
    expect([...(body?.disclose ?? [])].sort()).toEqual(["balance", "principal", "reputation"]);
    await expectOwnerSigned(
      body!.owner_authorization,
      owner.address,
      ownerPayloads.proofsDisclose(AGENT, {
        enabled: true,
        disclose: ["reputation", "principal", "balance"],
      }),
    );
    expect(await screen.findByText("Disclosure widened")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("asks for the owner key to turn proofs on", async () => {
    const user = userEvent.setup();
    const mock = proofsApi({ owner: account.owner_address, settings: settings(false, []) });
    renderWithProviders(<PrivateProofsCard agent={agent} accounts={[account]} />);
    await user.click(await screen.findByRole("button", { name: "Turn on…" }));
    const editor = await screen.findByRole("dialog", { name: "What research-bot may prove" });
    expect(within(editor).getByRole("checkbox", { name: "Private proofs on" })).toBeChecked();
    await user.click(within(editor).getByRole("checkbox", { name: "Principal" }));
    expect(
      within(editor).getByText(/Turning proofs on and disclosing Principal lets verifiers/),
    ).toBeInTheDocument();
    await user.click(within(editor).getByRole("button", { name: "Continue to owner signature…" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn on private proofs for research-bot" });
    expect(within(dialog).getByText("You are authorizing")).toBeInTheDocument();
    expect(bodiesOf(mock, SETTINGS_PATH, "PUT")).toHaveLength(0);
    // Cancelling the signature returns to the editor with the draft intact.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const back = await screen.findByRole("dialog", { name: "What research-bot may prove" });
    expect(within(back).getByRole("checkbox", { name: "Principal" })).toBeChecked();
  });

  it("removes a class without the owner key after a confirmation", async () => {
    const user = userEvent.setup();
    const mock = proofsApi({
      owner: account.owner_address,
      settings: settings(true, ["principal", "balance"]),
    });
    renderWithProviders(<PrivateProofsCard agent={agent} accounts={[account]} />);

    await user.click(await screen.findByRole("button", { name: "Edit disclosure…" }));
    const editor = await screen.findByRole("dialog", { name: "What research-bot may prove" });
    await user.click(within(editor).getByRole("checkbox", { name: "Balance" }));
    expect(within(editor).getByText("Narrowing applies immediately")).toBeInTheDocument();
    await user.click(within(editor).getByRole("button", { name: "Review and apply…" }));

    const confirm = await screen.findByRole("dialog", { name: "Narrow what research-bot may prove?" });
    expect(within(confirm).getByText("Stop disclosing Balance.")).toBeInTheDocument();
    expect(within(confirm).queryByText("You are authorizing")).not.toBeInTheDocument();
    expect(bodiesOf(mock, SETTINGS_PATH, "PUT")).toHaveLength(0);
    await user.click(within(confirm).getByRole("button", { name: "Narrow now" }));

    await waitFor(() => expect(bodiesOf(mock, SETTINGS_PATH, "PUT")).toHaveLength(1));
    expect(bodiesOf(mock, SETTINGS_PATH, "PUT")[0]).toEqual({ enabled: true, disclose: ["principal"] });
    expect(await screen.findByText("Disclosure narrowed")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("turns proofs off without the owner key after a confirmation", async () => {
    const user = userEvent.setup();
    const mock = proofsApi({ owner: account.owner_address, settings: settings(true, ["reservations"]) });
    renderWithProviders(<PrivateProofsCard agent={agent} accounts={[account]} />);

    await user.click(await screen.findByRole("button", { name: "Turn off" }));
    const confirm = await screen.findByRole("dialog", { name: "Turn off private proofs for research-bot?" });
    expect(within(confirm).getByText("Applies immediately")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Turn off now" }));
    await waitFor(() => expect(bodiesOf(mock, SETTINGS_PATH, "PUT")).toHaveLength(1));
    const [body] = bodiesOf(mock, SETTINGS_PATH, "PUT");
    expect(body).toEqual({ enabled: false, disclose: ["reservations"] });
    expect(body).not.toHaveProperty("owner_authorization");
    expect(await screen.findByText("Private proofs turned off")).toBeInTheDocument();
  });

  it("escalates to the owner key when the API classifies the change as widening", async () => {
    const user = userEvent.setup();
    proofsApi({
      owner: account.owner_address,
      settings: settings(true, ["principal", "balance"]),
      put: (body) =>
        body.owner_authorization
          ? undefined
          : jsonResponse(
              {
                title: "Owner signature required",
                status: 403,
                code: "owner_signature_required",
                detail: "Enabling private proofs or disclosing another class needs the owner's authorization",
              },
              403,
            ),
    });
    renderWithProviders(<PrivateProofsCard agent={agent} accounts={[account]} />);
    await user.click(await screen.findByRole("button", { name: "Turn off" }));
    const confirm = await screen.findByRole("dialog", { name: "Turn off private proofs for research-bot?" });
    await user.click(within(confirm).getByRole("button", { name: "Turn off now" }));
    expect(await screen.findByText("You are authorizing")).toBeInTheDocument();
  });

  it("releases a reservation early with a proofs.reservation.release owner authorization", async () => {
    const user = userEvent.setup();
    const owner = createSandboxKey();
    const mock = proofsApi({
      owner: owner.address,
      settings: settings(true, ["reservations"]),
      reservations: [reservation({ status: "pending", included_in_epoch: null })],
    });
    renderWithProviders(<PrivateProofsCard agent={agent} accounts={[account]} />);

    expect(await screen.findByText("Pending next root")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Release early/ }));
    const dialog = await screen.findByRole("dialog", { name: "Release a reservation early" });
    expect(within(dialog).getByText(/The agent cannot cancel a reservation/)).toBeInTheDocument();
    expect(within(dialog).getByText("proofs.reservation.release")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Use sandbox key" }));
    const sign = within(dialog).getByRole("button", { name: "Sign and release" });
    await waitFor(() => expect(sign).toBeEnabled());
    await user.click(sign);

    const path = `/v1/proofs/reservations/${RESERVATION}/release`;
    await waitFor(() => expect(bodiesOf(mock, path, "POST")).toHaveLength(1));
    const [body] = bodiesOf(mock, path, "POST") as { owner_authorization: OwnerAuthorization }[];
    await expectOwnerSigned(
      body!.owner_authorization,
      owner.address,
      ownerPayloads.proofReservationRelease(RESERVATION),
    );
    expect(await screen.findByText("Reservation released")).toBeInTheDocument();
  });
});

describe("ProofRootsCard", () => {
  it("lists recent public roots with their anonymity set and status", async () => {
    routes((path) => {
      if (path === "/v1/proofs/roots") {
        return jsonResponse(
          page([
            root(),
            root({ root: `0x${"3c".repeat(32)}`, epoch: "41", leaf_count: 20, status: "revoked" }),
          ]),
        );
      }
      return undefined;
    });
    renderWithProviders(<ProofRootsCard />);
    const table = await screen.findByRole("region", { name: "Attested-facts roots, newest first" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText("42")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Published")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("20")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Revoked")).toBeInTheDocument();
  });
});
