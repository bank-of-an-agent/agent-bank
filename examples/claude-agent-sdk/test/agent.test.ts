import { PolicyDeniedError } from "@agentbank/sdk";
import type { McpSdkServerConfigWithInstance, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  agentOptions,
  ALLOWED_TOOLS,
  DEFAULT_MODEL,
  runAgent,
  SERVER_NAME,
  type QueryFn,
} from "../src/agent";
import { MoneyTools } from "../src/money-tools";
import { asBackend, decision, fakeBackend, PAYEE } from "./fixtures";

/** Connect an MCP client to the in-process server the agent would get. */
async function connect(money: MoneyTools) {
  const server = agentOptions(money).mcpServers?.[SERVER_NAME] as McpSdkServerConfigWithInstance;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = (result.content[0] as { text: string }).text;
    return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
  };
  return { client, call };
}

describe("Claude Agent SDK: Agent Bank money tools", () => {
  it("locks the agent down to the money tools", () => {
    const options = agentOptions(new MoneyTools(asBackend(fakeBackend())));
    expect(options.model).toBe(DEFAULT_MODEL);
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual(ALLOWED_TOOLS);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.settingSources).toEqual([]);
    expect(Object.keys(options.mcpServers ?? {})).toEqual([SERVER_NAME]);
  });

  it("serves exactly five tools, none of which can change limits", async () => {
    const { client } = await connect(new MoneyTools(asBackend(fakeBackend())));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["check_spend", "fetch_paid_resource", "get_balance", "list_transactions", "pay"].sort(),
    );
    expect(tools.find((t) => t.name === "pay")?.annotations?.destructiveHint).toBe(true);
  });

  it("pays within the limits", async () => {
    const backend = fakeBackend();
    const money = new MoneyTools(asBackend(backend), {
      maxPerPayment: "5.00",
      maxPerRun: "6.00",
      maxPerHttpRequest: "0.10",
    });
    const { call } = await connect(money);
    const result = await call("pay", { to: PAYEE, amount: "2.50", memo: "dataset" });
    expect(result.isError).toBe(false);
    expect(result.body).toMatchObject({ status: "settled", amount: "2.50" });
    expect(backend.pay).toHaveBeenCalledWith(
      { to: PAYEE, amount: "2.50", memo: "dataset" },
      expect.objectContaining({ waitForSettlement: true }),
    );
    expect(money.spent).toBe("2.50");
  });

  it("refuses a payment above the per-payment limit without calling Agent Bank", async () => {
    const backend = fakeBackend();
    const { call } = await connect(new MoneyTools(asBackend(backend)));
    const result = await call("pay", { to: PAYEE, amount: "50.00" });
    expect(result.isError).toBe(true);
    expect(result.body).toMatchObject({ error: { code: "client_limit" } });
    expect(backend.pay).not.toHaveBeenCalled();
  });

  it("enforces the run budget across payments", async () => {
    const backend = fakeBackend();
    const money = new MoneyTools(asBackend(backend), {
      maxPerPayment: "5.00",
      maxPerRun: "6.00",
      maxPerHttpRequest: "0.10",
    });
    const { call } = await connect(money);
    expect((await call("pay", { to: PAYEE, amount: "4.00" })).isError).toBe(false);
    const second = await call("pay", { to: PAYEE, amount: "4.00" });
    expect(second.body).toMatchObject({ error: { code: "client_limit" } });
    expect(backend.pay).toHaveBeenCalledTimes(1);
  });

  it("returns policy denials as data and gives the budget back", async () => {
    const backend = fakeBackend();
    backend.pay.mockRejectedValueOnce(
      new PolicyDeniedError(
        "policy_denied",
        "Payment denied (counterparties.allowlist)",
        {},
        {
          decision: decision("deny"),
        },
      ),
    );
    const money = new MoneyTools(asBackend(backend));
    const { call } = await connect(money);
    const result = await call("pay", { to: PAYEE, amount: "1.00" });
    expect(result.body).toMatchObject({ error: { code: "policy_denied" } });
    expect(money.spent).toBe("0.00");
  });

  it("validates tool input before anything runs", async () => {
    const backend = fakeBackend();
    const { client } = await connect(new MoneyTools(asBackend(backend)));
    const result = (await client.callTool({
      name: "pay",
      arguments: { to: PAYEE, amount: 2.5 },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(backend.pay).not.toHaveBeenCalled();
  });

  it("returns Claude's final answer from the query stream", async () => {
    const stub = vi.fn(async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "You have 120.50 USDC available.",
      } as unknown as SDKMessage;
    });
    const answer = await runAgent(
      "What is my balance?",
      new MoneyTools(asBackend(fakeBackend())),
      stub as QueryFn,
    );
    expect(answer).toBe("You have 120.50 USDC available.");
    expect(stub).toHaveBeenCalledWith(expect.objectContaining({ prompt: "What is my balance?" }));
  });
});
