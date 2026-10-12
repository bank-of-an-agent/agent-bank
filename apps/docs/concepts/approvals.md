# Approvals

Approvals put a human in the loop for payments above a threshold. They come from the `approvals` ladder in the agent's [policy](/concepts/policies#approvals):

```json
"approvals": [
  { "above": "100.00", "approvers": 1 },
  { "above": "1000.00", "approvers": 2 }
]
```

A payment strictly above a threshold needs that many distinct approvers (the highest threshold it exceeds wins), and the policy decision is `require_approval` with `approvers_required` set. Every other rule still applies: a payment that is denied by a cap or an allowlist never reaches an approver.

## The flow

1. The agent creates the payment. The API places a hold for amount plus fee, so the money cannot be spent twice while the approval is open, and creates an [Approval](/api/schemas#approval) that **expires after 15 minutes**. The payment's status is `requires_approval` and an `approval.requested` webhook fires.
2. Approvers decide: members of the org with the **approver** or **admin** role. In the console each decision is confirmed with the member's passkey (WebAuthn); through the API it is `POST /v1/approvals/{id}/decide` with `{ "decision": "approve" }` or `{ "decision": "deny" }`.
3. Any **deny** denies the payment at once (status `denied`, hold voided, `payment.denied` webhook). Once the number of **approve** decisions reaches `required_approvers`, the approval is `approved` (`approval.decided` webhook) and the payment moves to `requires_signature`.
4. The agent signs and submits as for any payment; the co-signer re-checks every hard limit before co-signing.
5. If nobody decides within 15 minutes the approval `expired`, the hold is voided and the payment ends `expired`. Deciding after that returns `approval_expired`.

From the agent's side:

::: code-group

```ts [TypeScript]
const payment = await agent.pay(
  { to: "0x2222222222222222222222222222222222222222", amount: "250.00", memo: "annual data licence" },
  { waitForApproval: true, waitForSettlement: true, timeoutMs: 20 * 60_000 },
);
```

```python [Python]
payment = agent.pay(
    to="0x2222222222222222222222222222222222222222",
    amount="250.00",
    memo="annual data licence",
    wait_for_approval=True,
    wait_for_settlement=True,
    timeout=20 * 60,
)
```

:::

Without `waitForApproval` the SDK returns the `requires_approval` payment immediately; call `agent.completePayment(paymentId)` later to sign it once approved. The [MCP server](/guides/mcp-server)'s `pay` tool returns `requires_approval` with a message telling the model the payment has not been sent.

::: tip x402 cannot wait
An x402 request cannot be held open for a human, so an x402 payment that needs approval fails with `X402Error` reason `approval_required`. Keep x402 prices below your approval thresholds, or cap them per domain.
:::

## From the approver's side

List pending approvals with `GET /v1/approvals?status=pending`; each carries the payment id, the agent, the amount, the counterparty, `required_approvers`, the decisions so far and `expires_at`.

::: code-group

```ts [TypeScript]
for await (const approval of principal.paginate("listApprovals", { query: { status: "pending" } })) {
  console.log(approval.id, approval.amount.amount, approval.counterparty.address, approval.expires_at);
}
```

```python [Python]
for approval in bank.approvals.list_all(status="pending"):
    print(approval.id, approval.amount.amount, approval.expires_at)
```

:::

Subscribe to `approval.requested` [webhooks](/guides/webhooks) to route requests to Slack, email or your own tooling, and decide in the console.

## Limits of the v1 design

In v1 the API verifies the passkey assertion and passes the approval record to the co-signer, which trusts it ([ADR 0012](/operations/adrs)). A compromised API could therefore approve a payment that needs approval, but it still could not exceed any hard limit: the co-signer enforces caps, allowlists, velocity, mandates and the session scope independently, and the on-chain scope bounds the amount. The follow-up is to register approvers' credentials with the co-signer under an owner authorization and verify assertions there.
