# @agentbank/policy

The deterministic policy engine: compiles owner-written policy documents and AP2 mandates and
evaluates payment intents to `allow`, `deny`, `require_approval` or `require_owner`. No I/O, no
clock, no randomness, and no language model in the decision path.

Internal workspace package, used by the co-signer (the enforcement authority) and the API
(dry runs and display).

## Usage

```ts
import { compilePolicy, evaluate, classifyChange, requiresOwnerSignatureForChange } from "@agentbank/policy";

const policy = compilePolicy(document, 3);
const decision = evaluate(policy, {
  now,
  agent: { id, status: "active" },
  org: { status: "active" },
  intent: { kind: "transfer", amount: 25_000_000n, asset: "USDC", counterparty: { address } },
  history, // rolling 24h / 7d / 30d spend, velocity counts, counterparty first-seen
});
decision.outcome; // "deny"
decision.ruleHits.filter((h) => h.effect === "deny"); // e.g. limits.per_day

classifyChange(previous, next).kind; // "tighten" applies now; "loosen"/"mixed" need the owner + 1 hour
```

Rules cover amount caps (per transaction, day, week, month), counterparty allow and deny lists
(addresses, agent ids, ERC-8004 ids, x402 domains), per-counterparty caps, new-counterparty
cooling periods, velocity, time windows, approvals, owner-only thresholds, mandate constraints
and session scope. Every rule that fires is reported with a stable id.

## Evidence

- 283 tests, ~99% coverage (enforced ≥ 90%).
- Red-team suite: 1,636 adversarial intents (cap splitting, lookalike addresses, host tricks,
  DST edges, velocity bursts, frozen agents, expired sessions and mandates) — all denied — and
  266 benign controls, none denied.
- Property tests: determinism; a tightening never allows what the previous policy denied.

```bash
pnpm --filter @agentbank/policy test
pnpm --filter @agentbank/policy test:coverage
```
