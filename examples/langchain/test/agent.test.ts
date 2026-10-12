import { PolicyDeniedError } from "@agentbank/sdk";
import { AIMessage, fakeModel } from "langchain";
import { describe, expect, it } from "vitest";
import { moneyTools, runAgent } from "../src/agent";
import { MoneyTools } from "../src/money-tools";
import { asBackend, decision, fakeBackend, PAYEE } from "./fixtures";

/** Everything the model saw on a given call, as text. */
function seen(model: ReturnType<typeof fakeModel>, call: number): string {
  return JSON.stringify(model.calls[call]?.messages.map((m) => m.content));
}

describe("LangChain.js / LangGraph: Agent Bank money tools", () => {
  it("defines exactly the five money tools", () => {
    expect(
      moneyTools(new MoneyTools(asBackend(fakeBackend())))
        .map((t) => t.name)
        .sort(),
    ).toEqual(["check_spend", "fetch_paid_resource", "get_balance", "list_transactions", "pay"].sort());
  });

  it("pays when the model asks, within the limits", async () => {
    const model = fakeModel()
      .respondWithTools([{ name: "pay", args: { to: PAYEE, amount: "2.50", memo: "dataset" }, id: "call_1" }])
      .respond(new AIMessage("Paid 2.50 USDC."));
    const backend = fakeBackend();
    const money = new MoneyTools(asBackend(backend));
    await expect(runAgent("Buy the dataset for 2.50 USDC", money, model)).resolves.toBe("Paid 2.50 USDC.");
    expect(backend.pay).toHaveBeenCalledWith(
      { to: PAYEE, amount: "2.50", memo: "dataset" },
      expect.objectContaining({ waitForSettlement: true }),
    );
    expect(money.spent).toBe("2.50");
  });

  it("refuses an over-limit payment and tells the model why", async () => {
    const model = fakeModel()
      .respondWithTools([{ name: "pay", args: { to: PAYEE, amount: "500.00" }, id: "call_1" }])
      .respond(new AIMessage("That is above my limit."));
    const backend = fakeBackend();
    await runAgent("Pay 500 USDC", new MoneyTools(asBackend(backend)), model);
    expect(backend.pay).not.toHaveBeenCalled();
    expect(seen(model, 1)).toContain("client_limit");
  });

  it("passes policy denials back to the model as data", async () => {
    const model = fakeModel()
      .respondWithTools([{ name: "pay", args: { to: PAYEE, amount: "1.00" }, id: "call_1" }])
      .respond(new AIMessage("The owner's policy denied that."));
    const backend = fakeBackend();
    backend.pay.mockRejectedValueOnce(
      new PolicyDeniedError("policy_denied", "Payment denied", {}, { decision: decision("deny") }),
    );
    await runAgent("Pay 1 USDC", new MoneyTools(asBackend(backend)), model);
    expect(seen(model, 1)).toContain("policy_denied");
  });

  it("allows at most three pay calls per run", async () => {
    let model = fakeModel();
    for (let i = 1; i <= 4; i++) {
      model = model.respondWithTools([{ name: "pay", args: { to: PAYEE, amount: "1.00" }, id: `call_${i}` }]);
    }
    model = model.respond(new AIMessage("Done."));
    const backend = fakeBackend();
    await runAgent("Pay 1 USDC four times", new MoneyTools(asBackend(backend)), model);
    expect(backend.pay).toHaveBeenCalledTimes(3);
  });
});
