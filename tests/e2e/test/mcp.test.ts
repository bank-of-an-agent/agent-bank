import { usdc } from "@agentbank/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onboardAgent, randomAccount, type AgentWorld } from "../src/actors";
import { assertGlobalInvariants } from "../src/invariants";
import { connectMcp, type McpHarness } from "../src/mcp";
import { startStack, type Stack } from "../src/stack";

/**
 * The MCP server over its in-memory transport, backed by a real-HTTP agent client: the money
 * tools (`get_balance`, `check_spend`, `pay`, `list_transactions`) drive the full stack end to
 * end, the way a hosted agent would.
 */

let stack: Stack;
let world: AgentWorld;
let mcp: McpHarness;

beforeAll(async () => {
  stack = await startStack();
  world = await onboardAgent(stack, { name: "mcp", fund: usdc("100") });
  mcp = await connectMcp(world.agent);
}, 120_000);

afterAll(async () => {
  await mcp.close();
  await stack.stopStack();
});

describe("MCP money tools", () => {
  it("exposes the eight money tools and nothing that loosens limits", async () => {
    const { tools } = await mcp.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_balance");
    expect(names).toContain("pay");
    expect(names.join(" ")).not.toMatch(/withdraw|policy|unfreeze|session/);
  });

  it("reads the balance", async () => {
    const result = await mcp.call("get_balance");
    expect(result.isError).toBeFalsy();
    expect(mcp.parse(result)).toMatchObject({ available: "100.00", asset: "USDC" });
  });

  it("dry-runs a spend and then pays, settling on-chain", async () => {
    const payee = randomAccount().address;
    const check = mcp.parse(await mcp.call("check_spend", { amount: "10.00", to_address: payee }));
    expect(check).toMatchObject({ allowed: true, outcome: "allow" });

    const paid = mcp.parse(await mcp.call("pay", { amount: "10.00", to_address: payee, memo: "mcp pay" }));
    expect(paid.status).toBe("settled");
    expect(await stack.balanceOf(payee)).toBe(usdc("10"));

    const txns = mcp.parse(await mcp.call("list_transactions", {}));
    expect(Array.isArray((txns as { transactions?: unknown[] }).transactions)).toBe(true);

    await assertGlobalInvariants(stack, "mcp pay");
  });
});
