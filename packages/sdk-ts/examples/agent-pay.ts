/**
 * Agent payment: check the balance, dry-run a payment against the owner's
 * policy, then pay (create → sign the user operation with the session key →
 * submit → wait for settlement).
 *
 *   AGENTBANK_API_URL=http://localhost:8080 AGENTBANK_ACCOUNT_ID=acct_… \
 *   AGENTBANK_SESSION_ID=ses_… AGENTBANK_KEYSTORE=.agentbank/agent.keystore.json \
 *   pnpm --filter @agentbank/sdk exec tsx examples/agent-pay.ts 0xRecipient 2.50
 */
import { AgentClient, PolicyDeniedError } from "@agentbank/sdk";
import { FileKeyStore, loadKey } from "@agentbank/sdk/node";

const [to = "0x2222222222222222222222222222222222222222", amount = "1.00"] = process.argv.slice(2);
const sessionId = process.env.AGENTBANK_SESSION_ID ?? "";
const store = new FileKeyStore({ path: process.env.AGENTBANK_KEYSTORE ?? ".agentbank/agent.keystore.json" });
const sessionKey = await loadKey(store, `session:${sessionId}`);
if (!sessionKey) throw new Error(`No key for session ${sessionId} in the key store`);

const agent = new AgentClient({
  baseUrl: process.env.AGENTBANK_API_URL ?? "http://localhost:8080",
  accountId: process.env.AGENTBANK_ACCOUNT_ID ?? "",
  session: { id: sessionId, signer: sessionKey },
});

const balance = await agent.balance();
console.log(`available ${balance.available} USDC (reserved ${balance.reserved}, escrow ${balance.escrow})`);

const decision = await agent.checkSpend({ amount, to });
console.log(`dry run: ${decision.outcome} ${decision.rule_hits.map((h) => h.rule).join(", ")}`);

try {
  const payment = await agent.pay({ to, amount, memo: "example payment" }, { waitForSettlement: true });
  console.log(
    `payment ${payment.id}: ${payment.status} (fee ${payment.fee.amount} USDC, tx ${payment.tx_hash ?? "pending"})`,
  );
} catch (error) {
  if (error instanceof PolicyDeniedError) {
    console.error(`denied: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
