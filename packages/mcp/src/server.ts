import type { AgentClient, Escrow, Payment } from "@agentbank/sdk";
import { formatAmount, normalizeAmount, parseAmount } from "@agentbank/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toolError, toolInputError } from "./errors";
import { MCP_SERVER_VERSION } from "./version";

/**
 * The Agent Bank MCP server: money tools for agents, and nothing else.
 *
 * Eight tools: `get_balance`, `check_spend`, `pay`, `fetch_paid_resource`,
 * `request_payment`, `create_escrow`, `release_escrow`, `list_transactions`.
 * None of them can loosen limits, change policy, or withdraw to the owner:
 * the server holds only the agent's session key (and optional x402 spend
 * key), and every payment is checked by the owner's policy and co-signed by
 * Agent Bank. Amounts are decimal strings in USDC.
 *
 * @packageDocumentation
 */

/** The part of the SDK's `AgentClient` the tools use (mock it in tests). */
export type AgentBankBackend = Pick<
  AgentClient,
  | "accountId"
  | "balance"
  | "checkSpend"
  | "pay"
  | "fetchWithPayment"
  | "requestPayment"
  | "createEscrow"
  | "releaseEscrow"
  | "listTransactions"
>;

/** Options of {@link createAgentBankMcpServer}. */
export interface AgentBankMcpServerOptions {
  /** Hard cap per paid HTTP request, decimal USDC (default `"1.00"`). Tool input can only lower it. */
  maxX402PerCall?: string;
  /** How long `pay` waits for on-chain settlement before returning `submitted` (default 30000 ms). */
  settlementTimeoutMs?: number;
  /** Maximum characters of a fetched body returned to the model (default 20000). */
  maxResponseChars?: number;
  /** Server name advertised to clients (default `agentbank`). */
  name?: string;
}

const DECIMAL_RE = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/;
const ID_BODY = "[0-9A-HJKMNP-TV-Z]{26}";

const Amount = z
  .string()
  .regex(DECIMAL_RE, 'must be a decimal string with up to 6 decimals, e.g. "2.50"')
  .describe('Amount in USDC as a decimal string, e.g. "2.50". Never a number.');
const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address")
  .describe("EVM address (0x followed by 40 hex characters)");
const AgentId = z
  .string()
  .regex(new RegExp(`^agt_${ID_BODY}$`), "must be an agent id like agt_01J…")
  .describe("Agent Bank agent id (agt_…)");
const AccountId = z
  .string()
  .regex(new RegExp(`^acct_${ID_BODY}$`), "must be an account id like acct_01J…")
  .describe("Agent Bank account id (acct_…)");
const MandateId = z
  .string()
  .regex(new RegExp(`^mdt_${ID_BODY}$`), "must be a mandate id like mdt_01J…")
  .describe("AP2 mandate (mdt_…) to run the payment under, if your instructions name one");
const IdempotencyKey = z
  .string()
  .min(8)
  .max(255)
  .describe(
    "Optional. A unique string (8-255 chars) for this logical payment. If a call times out or fails with a network error, retry with the SAME key: the payment is then never made twice.",
  );
const Money = z.object({ amount: z.string(), asset: z.string() });
const RuleHit = z.object({ rule: z.string(), effect: z.string(), detail: z.string() });

const PaymentSummary = {
  payment_id: z.string(),
  status: z
    .string()
    .describe(
      "requires_approval, requires_signature, submitted, settled, denied, failed, canceled or expired",
    ),
  kind: z.string(),
  amount: Money,
  fee: Money,
  counterparty: z.object({
    address: z.string(),
    agent_id: z.string().nullable(),
    x402_domain: z.string().nullable(),
  }),
  memo: z.string().nullable(),
  tx_hash: z.string().nullable(),
  created_at: z.string(),
  settled_at: z.string().nullable(),
};

function paymentSummary(p: Payment) {
  return {
    payment_id: p.id,
    status: p.status,
    kind: p.kind,
    amount: p.amount,
    fee: p.fee,
    counterparty: {
      address: p.counterparty.address,
      agent_id: p.counterparty.agent_id,
      x402_domain: p.counterparty.x402_domain,
    },
    memo: p.memo,
    tx_hash: p.tx_hash,
    created_at: p.created_at,
    settled_at: p.settled_at,
  };
}

function escrowSummary(e: Escrow) {
  return {
    escrow_id: e.id,
    status: e.status,
    amount: e.amount,
    fee: e.fee,
    payee: { address: e.payee.address, agent_id: e.payee.agent_id },
    release: e.release,
    expires_at: e.expires_at,
    pending_action: e.pending_action,
    memo: e.memo,
  };
}

const EscrowSummary = {
  escrow_id: z.string(),
  status: z
    .string()
    .describe(
      "requires_signature, locking, locked, released, refunded, disputed, resolved, failed or canceled",
    ),
  amount: Money,
  fee: Money,
  payee: z.object({ address: z.string(), agent_id: z.string().nullable() }),
  release: z.string(),
  expires_at: z.string(),
  pending_action: z
    .string()
    .nullable()
    .describe(
      "On-chain action still waiting to be signed or confirmed (lock, release, refund, dispute), if any",
    ),
  memo: z.string().nullable(),
};

/** Successful tool result with both structured content and its JSON text. */
function ok(structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

function paymentMessage(status: string): string {
  switch (status) {
    case "settled":
      return "Payment settled on-chain.";
    case "submitted":
      return "Payment submitted; settlement is pending. Check list_transactions later.";
    case "requires_approval":
      return "Payment is waiting for a human approver (approvals expire after 15 minutes). It has not been sent.";
    default:
      return `Payment status: ${status}.`;
  }
}

const TEXT_TYPES =
  /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|ld\+json|problem\+json)|[^;]*\+(json|xml))/i;

/**
 * Create the MCP server with the eight money tools, backed by an
 * {@link AgentBankBackend} (an SDK `AgentClient` in production).
 */
export function createAgentBankMcpServer(
  backend: AgentBankBackend,
  options: AgentBankMcpServerOptions = {},
): McpServer {
  const cap = normalizeAmount(options.maxX402PerCall ?? "1.00", "maxX402PerCall");
  const settlementTimeoutMs = options.settlementTimeoutMs ?? 30_000;
  const maxChars = options.maxResponseChars ?? 20_000;

  const server = new McpServer(
    { name: options.name ?? "agentbank", version: MCP_SERVER_VERSION },
    {
      instructions: [
        "Agent Bank gives you a USDC account (Base Sepolia testnet) with spending limits set by your owner.",
        'All amounts are decimal strings in USDC, e.g. "2.50".',
        "Use check_spend before a large or unusual payment. A denied payment (policy_denied) is final: do not retry it with smaller split amounts to get around limits; tell the user instead.",
        "Payments above approval thresholds wait for a human (status requires_approval).",
        `fetch_paid_resource pays x402 paywalls automatically, at most ${cap} USDC per request.`,
        "When retrying pay or create_escrow after a timeout or network error, reuse the same idempotency_key.",
      ].join(" "),
    },
  );

  server.registerTool(
    "get_balance",
    {
      title: "Get balance",
      description:
        "Get this agent's USDC balances. `available` can be spent now; `reserved` is held for pending payments; `escrow` is locked in escrows; `savings` is in vaults; `spend_float` is the float used for paid HTTP requests (x402). All amounts are decimal strings.",
      inputSchema: {},
      outputSchema: {
        account_id: z.string(),
        asset: z.string(),
        available: z.string(),
        reserved: z.string(),
        escrow: z.string(),
        savings: z.string(),
        spend_float: z.string(),
        fees: z.string(),
        total: z.string(),
        as_of: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const b = await backend.balance();
        return ok({
          account_id: b.account_id,
          asset: b.asset,
          available: b.available,
          reserved: b.reserved,
          escrow: b.escrow,
          savings: b.savings,
          spend_float: b.spend_float,
          fees: b.fees,
          total: b.total,
          as_of: b.as_of,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "check_spend",
    {
      title: "Check a spend (dry run)",
      description:
        "Ask whether a payment would be allowed by the owner's spending policy, without moving any money. Returns the outcome (allow, deny, require_approval or require_owner) and the rules that fired. Give the recipient (to_address or to_agent_id) or, for a paid web API, its x402_domain.",
      inputSchema: {
        amount: Amount,
        to_address: Address.optional(),
        to_agent_id: AgentId.optional(),
        x402_domain: z
          .string()
          .min(1)
          .max(253)
          .optional()
          .describe("Hostname of a paid API (x402), e.g. api.example-data.com"),
        kind: z
          .enum(["transfer", "x402", "escrow", "stream"])
          .optional()
          .describe("Kind of payment (default transfer, or x402 when x402_domain is given)"),
        mandate_id: MandateId.optional(),
      },
      outputSchema: {
        allowed: z.boolean().describe("True only when the outcome is allow"),
        outcome: z.string(),
        approvers_required: z.number(),
        rule_hits: z.array(RuleHit),
        policy_version: z.number(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      if (input.to_address && input.to_agent_id)
        return toolInputError("Give at most one of to_address or to_agent_id");
      try {
        const d = await backend.checkSpend({
          amount: input.amount,
          ...(input.to_address
            ? { to: input.to_address }
            : input.to_agent_id
              ? { to: input.to_agent_id }
              : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.x402_domain ? { x402Domain: input.x402_domain } : {}),
          ...(input.mandate_id ? { mandateId: input.mandate_id } : {}),
        });
        return ok({
          allowed: d.outcome === "allow",
          outcome: d.outcome,
          approvers_required: d.approvers_required,
          rule_hits: d.rule_hits.map((h) => ({ rule: h.rule, effect: h.effect, detail: h.detail })),
          policy_version: d.policy_version,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "pay",
    {
      title: "Pay",
      description:
        "Send USDC from this agent's account to exactly one recipient: an address (to_address), another agent (to_agent_id) or an Agent Bank account (to_account_id). The owner's policy is enforced and Agent Bank co-signs; a 0.20% fee (max 5.00 USDC) applies. Waits briefly for on-chain settlement and returns the status: settled, submitted (still settling) or requires_approval (a human must approve). A denial returns an error with code policy_denied. Payments cannot be undone.",
      inputSchema: {
        amount: Amount,
        to_address: Address.optional(),
        to_agent_id: AgentId.optional(),
        to_account_id: AccountId.optional(),
        memo: z
          .string()
          .max(500)
          .optional()
          .describe("What the payment is for (visible to the owner and in statements)"),
        mandate_id: MandateId.optional(),
        idempotency_key: IdempotencyKey.optional(),
      },
      outputSchema: { ...PaymentSummary, message: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const targets = [input.to_address, input.to_agent_id, input.to_account_id].filter(Boolean);
      if (targets.length !== 1)
        return toolInputError("Give exactly one of to_address, to_agent_id or to_account_id");
      try {
        const payment = await backend.pay(
          {
            to: targets[0] as string,
            amount: input.amount,
            ...(input.memo !== undefined ? { memo: input.memo } : {}),
            ...(input.mandate_id ? { mandateId: input.mandate_id } : {}),
          },
          {
            waitForSettlement: true,
            timeoutMs: settlementTimeoutMs,
            ...(input.idempotency_key ? { idempotencyKey: input.idempotency_key } : {}),
          },
        );
        return ok({ ...paymentSummary(payment), message: paymentMessage(payment.status) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "fetch_paid_resource",
    {
      title: "Fetch a paid web resource (x402)",
      description: `Fetch an http(s) URL. If the server answers 402 Payment Required with an x402 offer, pay it automatically in USDC from this agent's x402 float, within the owner's policy and never more than ${cap} USDC per request (lower it with max_amount), then return the response. Free resources are returned without paying. Text bodies are returned (truncated to ${maxChars} characters); binary bodies are summarized.`,
      inputSchema: {
        url: z.url().describe("http(s) URL to fetch"),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
          .optional()
          .describe("HTTP method (default GET)"),
        headers: z.record(z.string(), z.string()).optional().describe("Extra request headers"),
        body: z.string().max(100_000).optional().describe("Request body (for POST/PUT/PATCH)"),
        max_amount: Amount.optional().describe(
          `Lower the per-request price cap (USDC). Cannot exceed ${cap}.`,
        ),
      },
      outputSchema: {
        status: z.number(),
        paid: z.boolean(),
        amount_paid: z.string().nullable(),
        payment_id: z.string().nullable(),
        transaction: z.string().nullable().describe("On-chain settlement transaction reported by the seller"),
        content_type: z.string().nullable(),
        body: z.string(),
        truncated: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        return toolInputError("url must be an absolute http(s) URL");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:")
        return toolInputError("Only http(s) URLs can be fetched");
      const method = input.method ?? "GET";
      if (input.body !== undefined && (method === "GET" || method === "HEAD")) {
        return toolInputError(`A ${method} request cannot have a body`);
      }
      let maxAmount = cap;
      if (input.max_amount !== undefined) {
        const requested = parseAmount(input.max_amount, 6);
        if (requested < parseAmount(cap, 6)) maxAmount = formatAmount(requested, 6);
      }
      try {
        const result = await backend.fetchWithPayment(
          url.toString(),
          {
            method,
            ...(input.headers ? { headers: input.headers } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
          },
          { maxAmountPerRequest: maxAmount },
        );
        const contentType = result.response.headers.get("content-type");
        let body = "";
        let truncated = false;
        if (method !== "HEAD") {
          if (!contentType || TEXT_TYPES.test(contentType)) {
            const text = await result.response.text();
            truncated = text.length > maxChars;
            body = truncated ? text.slice(0, maxChars) : text;
          } else {
            const bytes = (await result.response.arrayBuffer()).byteLength;
            body = `[${bytes} bytes of ${contentType} omitted]`;
          }
        }
        return ok({
          status: result.response.status,
          paid: result.paid,
          amount_paid: result.paid ? (result.amount ?? null) : null,
          payment_id: result.payment?.id ?? null,
          transaction: result.settlement?.transaction || null,
          content_type: contentType,
          body,
          truncated,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "request_payment",
    {
      title: "Request a payment",
      description:
        "Create a payment request asking another agent or a human to pay this account. Returns a pay_link to share and the address to pay. Nothing is charged to this account.",
      inputSchema: {
        amount: Amount,
        memo: z.string().max(500).optional().describe("What the payment is for"),
        reference: z.string().max(200).optional().describe("Your own reference, e.g. an invoice number"),
        expires_in_seconds: z
          .number()
          .int()
          .min(60)
          .max(30 * 24 * 3600)
          .optional()
          .describe("How long the request stays open (default 7 days)"),
      },
      outputSchema: {
        payment_request_id: z.string(),
        status: z.string(),
        amount: Money,
        pay_to: z.string(),
        pay_link: z.string(),
        reference: z.string().nullable(),
        expires_at: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const r = await backend.requestPayment({
          amount: input.amount,
          ...(input.memo !== undefined ? { memo: input.memo } : {}),
          ...(input.reference !== undefined ? { reference: input.reference } : {}),
          ...(input.expires_in_seconds !== undefined ? { expiresInSeconds: input.expires_in_seconds } : {}),
        });
        return ok({
          payment_request_id: r.id,
          status: r.status,
          amount: r.amount,
          pay_to: r.pay_to,
          pay_link: r.pay_link,
          reference: r.reference,
          expires_at: r.expires_at,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "create_escrow",
    {
      title: "Create an escrow",
      description:
        "Lock USDC in escrow for a task, to be released to the payee when the work is accepted (release_escrow) or refunded after expiry. Give exactly one payee (payee_address or payee_agent_id). Fee: 1% (min 1.00 USDC). Subject to the owner's policy. Returns the escrow id and status (locked once on-chain).",
      inputSchema: {
        amount: Amount,
        payee_address: Address.optional(),
        payee_agent_id: AgentId.optional(),
        expires_in_hours: z
          .number()
          .int()
          .min(1)
          .max(24 * 365)
          .optional()
          .describe("Hours until the payer may reclaim the funds (default 168 = 7 days)"),
        terms: z
          .string()
          .max(10_000)
          .optional()
          .describe("What the payee must deliver; only its hash goes on-chain"),
        memo: z.string().max(500).optional(),
        release: z
          .enum(["payer", "arbiter"])
          .optional()
          .describe("Who releases the funds: payer (default) or an arbiter"),
        arbiter: Address.optional().describe("Arbiter address, required when release is arbiter"),
        mandate_id: MandateId.optional(),
        idempotency_key: IdempotencyKey.optional(),
      },
      outputSchema: EscrowSummary,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const payees = [input.payee_address, input.payee_agent_id].filter(Boolean);
      if (payees.length !== 1) return toolInputError("Give exactly one of payee_address or payee_agent_id");
      if (input.release === "arbiter" && !input.arbiter)
        return toolInputError("arbiter is required when release is arbiter");
      try {
        const escrow = await backend.createEscrow(
          {
            payee: payees[0] as string,
            amount: input.amount,
            expiresInSeconds: (input.expires_in_hours ?? 168) * 3600,
            ...(input.terms !== undefined ? { terms: input.terms } : {}),
            ...(input.memo !== undefined ? { memo: input.memo } : {}),
            ...(input.release ? { release: input.release } : {}),
            ...(input.arbiter ? { arbiter: input.arbiter } : {}),
            ...(input.mandate_id ? { mandateId: input.mandate_id } : {}),
          },
          {
            waitForSettlement: true,
            timeoutMs: settlementTimeoutMs,
            ...(input.idempotency_key ? { idempotencyKey: input.idempotency_key } : {}),
          },
        );
        return ok(escrowSummary(escrow));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "release_escrow",
    {
      title: "Release an escrow",
      description:
        "Release a locked escrow to its payee once the task is done. This pays the payee and cannot be undone. Only the payer can release (unless an arbiter decides).",
      inputSchema: {
        escrow_id: z
          .string()
          .regex(new RegExp(`^esc_${ID_BODY}$`), "must be an escrow id like esc_01J…")
          .describe("Escrow id (esc_…) from create_escrow"),
        idempotency_key: IdempotencyKey.optional(),
      },
      outputSchema: EscrowSummary,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        const escrow = await backend.releaseEscrow(input.escrow_id, {
          waitForSettlement: true,
          timeoutMs: settlementTimeoutMs,
          ...(input.idempotency_key ? { idempotencyKey: input.idempotency_key } : {}),
        });
        return ok(escrowSummary(escrow));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_transactions",
    {
      title: "List transactions",
      description:
        "List this agent's payments, newest first: transfers, x402 purchases, escrows, streams and float refills, with amount, fee, counterparty and status. Incoming deposits are reflected in get_balance. Use next_cursor to page.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe("How many to return (default 20)"),
        cursor: z.string().max(500).optional().describe("next_cursor from a previous call"),
        status: z
          .enum([
            "requires_approval",
            "requires_signature",
            "submitted",
            "settled",
            "denied",
            "failed",
            "canceled",
            "expired",
          ])
          .optional()
          .describe("Only payments with this status"),
      },
      outputSchema: {
        transactions: z.array(z.object(PaymentSummary)),
        next_cursor: z.string().nullable(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const page = await backend.listTransactions({
          limit: input.limit ?? 20,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.status ? { status: input.status } : {}),
        });
        return ok({ transactions: page.data.map(paymentSummary), next_cursor: page.next_cursor });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

/** Names of the tools the server exposes. */
export const TOOL_NAMES = [
  "get_balance",
  "check_spend",
  "pay",
  "fetch_paid_resource",
  "request_payment",
  "create_escrow",
  "release_escrow",
  "list_transactions",
] as const;
