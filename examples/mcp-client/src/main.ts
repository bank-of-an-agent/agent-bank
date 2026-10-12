/**
 * Any MCP client + Agent Bank quickstart: start (or reach) the Agent Bank
 * MCP server, list its money tools, read the balance, dry-run a payment and,
 * if you confirm on the terminal, pay.
 *
 *   export AGENTBANK_ACCOUNT_ID=acct_… AGENTBANK_SESSION_ID=ses_…   # from the principal setup
 *   pnpm --filter @agentbank/example-mcp-client start 0x2222222222222222222222222222222222222222 1.00
 *
 * Stdio (default) runs `npx -y @agentbank/mcp`; set AGENTBANK_MCP_COMMAND to run
 * another build, or AGENTBANK_MCP_URL (+ AGENTBANK_MCP_HTTP_TOKEN) to reach a
 * server started with `agentbank-mcp --http`.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { callTool, connect, movesMoney, transportFromEnv, type Confirm } from "./client";

const askOnTerminal: Confirm = async (tool, args) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Run ${tool.name} ${JSON.stringify(args)}? [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
};

const client = await connect(transportFromEnv());
try {
  const { tools } = await client.listTools();
  console.log(`Tools: ${tools.map((t) => (movesMoney(t) ? `${t.name} (moves money)` : t.name)).join(", ")}`);

  const balance = await callTool(client, tools, "get_balance", {}, askOnTerminal);
  console.log("Balance:", balance.data);

  const [to, amount] = process.argv.slice(2);
  if (to && amount) {
    const check = await callTool(client, tools, "check_spend", { amount, to_address: to }, askOnTerminal);
    console.log("Dry run:", check.data);
    if (check.ok && check.data.allowed === true) {
      const paid = await callTool(
        client,
        tools,
        "pay",
        // Reuse the same idempotency key if you retry after a timeout: the payment is never made twice.
        { amount, to_address: to, memo: "MCP quickstart", idempotency_key: randomUUID() },
        askOnTerminal,
      );
      console.log(paid.ok ? "Payment:" : "Not paid:", paid.data);
    }
  }
} finally {
  await client.close();
}
