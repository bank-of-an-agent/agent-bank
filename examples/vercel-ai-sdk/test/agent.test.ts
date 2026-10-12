import { PolicyDeniedError } from "@agentbank/sdk";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { moneyTools, runAgent } from "../src/agent";
import { MoneyTools } from "../src/money-tools";
import { asBackend, decision, fakeBackend, PAYEE } from "./fixtures";

const usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

/** A scripted model: first a tool call, then a text answer. No Anthropic call is made. */
function scripted(toolName: string, input: Record<string, unknown>, answer: string) {
  return new MockLanguageModelV4({
    doGenerate: [
      {
        content: [{ type: "tool-call", toolCallId: "call_1", toolName, input: JSON.stringify(input) }],
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: answer }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage,
        warnings: [],
      },
    ],
  });
}

/** What the model saw as the result of its tool call, on its second turn. */
function toolResultSeen(model: MockLanguageModelV4): string {
  return JSON.stringify(model.doGenerateCalls[1]?.prompt);
}

describe("Vercel AI SDK: Agent Bank money tools", () => {
  it("defines exactly the five money tools", () => {
    expect(Object.keys(moneyTools(new MoneyTools(asBackend(fakeBackend())))).sort()).toEqual(
      ["check_spend", "fetch_paid_resource", "get_balance", "list_transactions", "pay"].sort(),
    );
  });

  it("pays when the model asks, within the limits", async () => {
    const model = scripted("pay", { to: PAYEE, amount: "2.50", memo: "dataset" }, "Paid 2.50 USDC.");
    const backend = fakeBackend();
    const money = new MoneyTools(asBackend(backend));
    await expect(runAgent("Buy the dataset for 2.50 USDC", money, { model })).resolves.toBe(
      "Paid 2.50 USDC.",
    );
    expect(backend.pay).toHaveBeenCalledWith(
      { to: PAYEE, amount: "2.50", memo: "dataset" },
      expect.objectContaining({ waitForSettlement: true }),
    );
    expect(model.doGenerateCalls[0]?.providerOptions).toMatchObject({ anthropic: { fallbacks: "default" } });
  });

  it("refuses an over-limit payment and tells the model why", async () => {
    const model = scripted("pay", { to: PAYEE, amount: "500.00" }, "That is above my limit.");
    const backend = fakeBackend();
    await runAgent("Pay 500 USDC", new MoneyTools(asBackend(backend)), { model });
    expect(backend.pay).not.toHaveBeenCalled();
    expect(toolResultSeen(model)).toContain("client_limit");
  });

  it("passes policy denials back to the model as data", async () => {
    const model = scripted("pay", { to: PAYEE, amount: "1.00" }, "The owner's policy denied that.");
    const backend = fakeBackend();
    backend.pay.mockRejectedValueOnce(
      new PolicyDeniedError("policy_denied", "Payment denied", {}, { decision: decision("deny") }),
    );
    const money = new MoneyTools(asBackend(backend));
    await runAgent("Pay 1 USDC", money, { model });
    expect(toolResultSeen(model)).toContain("policy_denied");
    expect(money.spent).toBe("0.00");
  });
});
