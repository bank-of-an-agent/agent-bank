import { PolicyDeniedError } from "@agentbank/sdk";
import { setTracingDisabled } from "@openai/agents";
import { assistantMessage, functionCall, ScriptedModel } from "@openai/agents/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createBuyerAgent, runAgent } from "../src/agent";
import { MoneyTools } from "../src/money-tools";
import { asBackend, decision, fakeBackend, PAYEE } from "./fixtures";

// The model is scripted (no OpenAI call) and traces are not exported.
beforeAll(() => setTracingDisabled(true));

describe("OpenAI Agents SDK: Agent Bank money tools", () => {
  it("gives the agent exactly the five money tools", () => {
    const agent = createBuyerAgent(new MoneyTools(asBackend(fakeBackend())), new ScriptedModel());
    expect(agent.tools.map((t) => t.name).sort()).toEqual(
      ["check_spend", "fetch_paid_resource", "get_balance", "list_transactions", "pay"].sort(),
    );
  });

  it("pays when the model asks, within the limits", async () => {
    const model = new ScriptedModel([
      [functionCall("pay", { to: PAYEE, amount: "2.50", memo: "dataset" }, { callId: "call_pay" })],
      [assistantMessage("Paid 2.50 USDC for the dataset.")],
    ]);
    const backend = fakeBackend();
    const money = new MoneyTools(asBackend(backend));
    const answer = await runAgent("Buy the dataset for 2.50 USDC", money, { model });
    expect(answer).toBe("Paid 2.50 USDC for the dataset.");
    expect(backend.pay).toHaveBeenCalledWith(
      { to: PAYEE, amount: "2.50", memo: "dataset" },
      expect.objectContaining({ waitForSettlement: true }),
    );
    expect(money.spent).toBe("2.50");
    model.assertComplete();
  });

  it("refuses an over-limit payment and tells the model why", async () => {
    const model = new ScriptedModel([
      [functionCall("pay", { to: PAYEE, amount: "500.00" }, { callId: "call_pay" })],
      [assistantMessage("That is above my per-payment limit, so I did not pay.")],
    ]);
    const backend = fakeBackend();
    await runAgent("Pay 500 USDC", new MoneyTools(asBackend(backend)), { model });
    expect(backend.pay).not.toHaveBeenCalled();
    expect(JSON.stringify(model.calls[1]?.request.input)).toContain("client_limit");
  });

  it("passes policy denials back to the model as data", async () => {
    const model = new ScriptedModel([
      [functionCall("pay", { to: PAYEE, amount: "1.00" }, { callId: "call_pay" })],
      [assistantMessage("The owner's policy denied that payment.")],
    ]);
    const backend = fakeBackend();
    backend.pay.mockRejectedValueOnce(
      new PolicyDeniedError("policy_denied", "Payment denied", {}, { decision: decision("deny") }),
    );
    const money = new MoneyTools(asBackend(backend));
    await runAgent("Pay 1 USDC", money, { model });
    expect(JSON.stringify(model.calls[1]?.request.input)).toContain("policy_denied");
    expect(money.spent).toBe("0.00");
  });
});
