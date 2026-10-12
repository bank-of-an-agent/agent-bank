# The ledger

The chain holds the balances; the ledger holds their meaning. Agent Bank keeps an append-only, double-entry ledger that records why every unit of USDC moved: which payment, agent, mandate and policy decision caused it. Because the bank is non-custodial, every movement between accounts settles on-chain, the ledger never invents balances, and an indexer proves each entry against the chain ([Reconciliation](/concepts/reconciliation)).

## Rules

- Amounts are integers in the asset's smallest unit (USDC has 6 decimals), stored in 64-bit columns. There are no floats anywhere; the API shows them as decimal strings.
- Journal entries are immutable. A correction is a new entry that reverses the original (`reverses_entry_id`), never an edit.
- Every entry's lines sum to zero, enforced by the library and by a deferred database constraint, and carry the payment, agent, mandate and policy decision ids that caused it.
- Pockets never go negative; system accounts may.
- Every write takes an idempotency key; a retry returns the original entry.
- Balances are derived from the journal. The cached balance is a projection, checked nightly, never authoritative.
- Storage is PostgreSQL with serializable transactions, behind a `Ledger` interface so a dedicated engine (TigerBeetle, for example) can replace it without API changes.

## Ledger accounts

| Code                          | Owner   | Where the funds are                               | Notes                                                                  |
| ----------------------------- | ------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `pocket:operating`            | account | Smart account                                     | Spendable (`available` in the balances)                                |
| `pocket:reserved`             | account | Smart account                                     | Holds for pending payments from `operating`                            |
| `pocket:fees`                 | account | Smart account                                     | Fees accrued and owed, swept with the next outgoing operation          |
| `pocket:savings`              | account | Smart account                                     | Earmarked for the treasury by auto-save, swept with the next operation |
| `pocket:vault:<vlt_id>`       | account | Smart account (goal) or `TimeLockVaults` (locked) | Agents cannot spend from vaults                                        |
| `pocket:escrow`               | account | `AgentEscrow` contract                            | Locked escrow funds                                                    |
| `pocket:stream`               | account | `PaymentStreams` contract                         | Unstreamed stream deposits                                             |
| `pocket:spend`                | account | Spend-key EOA                                     | The x402 float                                                         |
| `pocket:spend_reserved`       | account | Spend-key EOA                                     | Holds on the float for pending x402 payments                           |
| `sys:chain:<chainId>:<asset>` | system  | Outside Agent Bank                                | Mirror of value entering and leaving known addresses                   |
| `sys:revenue`                 | system  | Agent Bank's revenue address                      | Fee income                                                             |
| `sys:suspense`                | system  | None                                              | Unmatched chain movements awaiting review                              |

`GET /v1/accounts/{id}/balances` reports them per account: `available` (operating), `reserved`, `escrow`, `fees`, `savings` (goal and locked vaults, also listed one by one), `spend_float` (spend plus spend_reserved) and `total`.

## Holds

Money moves in two phases. A **hold** reserves amount plus fee when a payment is authorized (`operating → reserved`), so concurrent payments cannot spend the same funds. The hold is then **posted** when the chain confirms the transfer, optionally for a smaller amount with the remainder released, or **voided** when the payment is denied, fails or expires. Holds expire at the signature deadline plus one hour; a background job voids them.

## Movements

Each movement is one balanced entry, written as signed lines (amounts in USDC minor units, `x` the amount, `f` the fee):

| Movement                                      | Lines                                                                                                                             | Posted by                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Deposit                                       | `sys:chain −x`, `operating +x`                                                                                                    | Indexer, on chain evidence    |
| Hold for a payment                            | `operating −(x+f)`, `reserved +(x+f)`                                                                                             | API, at payment creation      |
| Payment settles to an external address        | `reserved −(x+f)`, `sys:chain +x`, `sys:revenue +f`                                                                               | Indexer, matching the user op |
| Payment settles to another Agent Bank account | `reserved(A) −(x+f)`, `operating(B) +x`, `sys:revenue +f`                                                                         | Indexer                       |
| Hold voided (denied, expired, failed)         | `reserved −(x+f)`, `operating +(x+f)`                                                                                             | API or worker                 |
| Spend-key refill                              | Hold from `operating`; on settlement `reserved −r`, `spend +r`                                                                    | API and indexer               |
| x402 payment                                  | Hold `spend −x`, `spend_reserved +x`; on `AuthorizationUsed`: `spend_reserved −x`, `sys:chain +x` (or the payee's `operating +x`) | API and indexer               |
| x402 receive fee (seller)                     | `operating −f`, `fees +f` (accrual)                                                                                               | Worker, after settlement      |
| Escrow lock                                   | Hold; on `Locked`: `reserved −(x+f)`, `escrow +x`, `sys:revenue +f`                                                               | Indexer                       |
| Escrow release                                | `escrow(A) −x`, `sys:chain +x` or `operating(B) +x`                                                                               | Indexer                       |
| Escrow refund                                 | `escrow −x`, `operating +x`                                                                                                       | Indexer                       |
| Stream create                                 | Hold; on `StreamCreated`: `reserved −(d+f)`, `stream +d`, `sys:revenue +f`                                                        | Indexer                       |
| Stream settle                                 | `stream(A) −s`, `sys:chain +s` or `operating(B) +s`                                                                               | Indexer                       |
| Fee sweep                                     | `fees −f`, `sys:revenue +f` (batched into the next outgoing operation)                                                            | Indexer                       |
| Goal-vault save                               | `operating −x`, `vault:<id> +x` (ledger only)                                                                                     | API or worker                 |
| Reversal                                      | The original lines negated, `reverses_entry_id` set                                                                               | Ledger                        |
| Unmatched outflow                             | `operating −x` (or `spend −x`), `sys:suspense +x`; the agent's sessions are paused                                                | Indexer                       |

## Reading the ledger

`GET /v1/accounts/{id}/entries` lists every entry touching an account, newest first, each with its lines and the ids that explain it:

```json
{
  "id": "ent_01JABCDEFGHJKMNPQRSTVWXYZ0",
  "object": "ledger_entry",
  "ref_type": "payment",
  "ref_id": "pay_01JABCDEFGHJKMNPQRSTVWXYZ0",
  "payment_id": "pay_01JABCDEFGHJKMNPQRSTVWXYZ0",
  "agent_id": "agt_01JABCDEFGHJKMNPQRSTVWXYZ0",
  "mandate_id": null,
  "decision_id": "dec_01JABCDEFGHJKMNPQRSTVWXYZ0",
  "reverses_entry_id": null,
  "memo": "dataset purchase",
  "lines": [
    {
      "ledger_account": "pocket:reserved",
      "account_id": "acct_01JABCDEFGHJKMNPQRSTVWXYZ0",
      "amount": "-2.505",
      "asset": "USDC"
    },
    { "ledger_account": "sys:chain:84532:USDC", "account_id": null, "amount": "2.50", "asset": "USDC" },
    { "ledger_account": "sys:revenue", "account_id": null, "amount": "0.005", "asset": "USDC" }
  ],
  "created_at": "2026-10-11T12:00:03.000Z"
}
```

In the SDKs: `agent.listEntries()` and `client.ledger.listEntries(accountId)` (TypeScript), `client.ledger.list_entries_all(...)` (Python).

## Statements

`GET /v1/statements?account_id=acct_…&period=2026-10` returns the monthly statement generated from the ledger: opening and closing balance, total in, total out, fees, the entry count, and one line per entry with a description, the signed amount and the running balance. Add `format=csv` (or `Accept: text/csv`) for a CSV export for accounting. A `statement.ready` webhook fires when a month's statement is available.

::: code-group

```ts [TypeScript]
const statement = await principal.ledger.statement({ account_id: account.id, period: "2026-10" });
const csv = await principal.ledger.statementCsv({ account_id: account.id, period: "2026-10" });
```

```python [Python]
statement = bank.ledger.statement(account_id=account.id, period="2026-10")
csv = bank.ledger.statement(account_id=account.id, period="2026-10", format="csv")
```

:::

## Invariants

Checked in CI and nightly: the lines of every entry sum to zero; each chain event matches at most one entry; no payment reaches `settled` without an `allow` decision or a recorded approval; balances are derived from the journal; and for every account the on-chain balance equals the sum of the pockets held at that address.
