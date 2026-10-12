import type { AgentBankBackend } from "@agentbank/mcp";
import { createAgentBankMcpServer } from "@agentbank/mcp";
import type { Balances, Payment, PolicyDecision } from "@agentbank/sdk";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { callTool, connect, movesMoney, transportFromEnv } from "../src/client";

const ACCOUNT = "acct_01JABCDEFGHJKMNPQRSTVWXYZ0";
const PAYEE = "0x2222222222222222222222222222222222222222";
const NOW = "2026-10-11T12:00:00.000Z";

function payment(amount: string): Payment {
  return {
    id: "pay_01JABCDEFGHJKMNPQRSTVWXYZ0",
    object: "payment",
    account_id: ACCOUNT,
    kind: "transfer",
    status: "settled",
    amount: { amount, asset: "USDC" },
    fee: { amount: "0.002", asset: "USDC" },
    counterparty: { type: "address", address: PAYEE, agent_id: null, x402_domain: null },
    memo: "MCP quickstart",
    mandate_id: null,
    payment_request_id: null,
    decision: null,
    approval_id: null,
    escrow_id: null,
    stream_id: null,
    signing_request: null,
    owner_operation_id: null,
    user_op_hash: null,
    tx_hash: `0x${"ab".repeat(32)}`,
    failure_reason: null,
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    settled_at: NOW,
  };
}

const balances: Balances = {
  object: "balances",
  account_id: ACCOUNT,
  asset: "USDC",
  available: "120.50",
  reserved: "0.00",
  escrow: "0.00",
  fees: "0.00",
  savings: "0.00",
  spend_float: "5.00",
  vaults: [],
  total: "125.50",
  as_of: NOW,
};

const allow: PolicyDecision = {
  outcome: "allow",
  rule_hits: [
    { rule: "limits.per_tx", effect: "allow", detail: "1.00 USDC is within the per-transaction limit" },
  ],
  approvers_required: 0,
  policy_version: 1,
  evaluated_at: NOW,
};

/** The real Agent Bank MCP server on a fake backend, connected in memory: no network, no keys. */
async function setup() {
  const backend = {
    accountId: ACCOUNT,
    balance: vi.fn(async () => balances),
    checkSpend: vi.fn(async () => allow),
    pay: vi.fn(async (input: { amount: string }) => payment(input.amount)),
    fetchWithPayment: vi.fn(),
    requestPayment: vi.fn(),
    createEscrow: vi.fn(),
    releaseEscrow: vi.fn(),
    listTransactions: vi.fn(async () => ({ data: [], next_cursor: null })),
  };
  const server = createAgentBankMcpServer(backend as unknown as AgentBankBackend);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = await connect(clientSide);
  const { tools } = await client.listTools();
  return { backend, client, tools };
}

describe("Any MCP client: Agent Bank money tools", () => {
  it("lists the eight money tools and flags the ones that move money", async () => {
    const { tools } = await setup();
    expect(tools).toHaveLength(8);
    const moving = tools.filter(movesMoney).map((t) => t.name);
    expect(moving.sort()).toEqual(["create_escrow", "fetch_paid_resource", "pay", "release_escrow"]);
  });

  it("reads without asking", async () => {
    const { client, tools } = await setup();
    const confirm = vi.fn(async () => false);
    const outcome = await callTool(client, tools, "get_balance", {}, confirm);
    expect(outcome).toMatchObject({ ok: true, data: { available: "120.50" } });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not pay unless confirmed", async () => {
    const { backend, client, tools } = await setup();
    const outcome = await callTool(
      client,
      tools,
      "pay",
      { amount: "1.00", to_address: PAYEE },
      async () => false,
    );
    expect(outcome).toMatchObject({ ok: false, data: { error: { code: "declined" } } });
    expect(backend.pay).not.toHaveBeenCalled();
  });

  it("pays once confirmed", async () => {
    const { backend, client, tools } = await setup();
    const outcome = await callTool(
      client,
      tools,
      "pay",
      { amount: "1.00", to_address: PAYEE, idempotency_key: "quickstart-0001" },
      async () => true,
    );
    expect(outcome).toMatchObject({ ok: true, data: { status: "settled" } });
    expect(backend.pay).toHaveBeenCalledWith(
      expect.objectContaining({ to: PAYEE, amount: "1.00" }),
      expect.objectContaining({ idempotencyKey: "quickstart-0001" }),
    );
  });

  it("returns the server's input errors as data", async () => {
    const { client, tools } = await setup();
    const outcome = await callTool(client, tools, "pay", { amount: "1.00" }, async () => true);
    expect(outcome.ok).toBe(false);
  });

  it("chooses stdio or streamable HTTP from the environment", () => {
    expect(transportFromEnv({ AGENTBANK_MCP_COMMAND: "node dist/cli.js" })).toBeInstanceOf(
      StdioClientTransport,
    );
    expect(
      transportFromEnv({
        AGENTBANK_MCP_URL: "http://127.0.0.1:8090/mcp",
        AGENTBANK_MCP_HTTP_TOKEN: "x".repeat(32),
      }),
    ).toBeInstanceOf(StreamableHTTPClientTransport);
  });
});
