# Agent Bank console

The principal dashboard (Next.js): sign in with a passkey, approve or deny queued payments,
freeze agents, edit policies, sign owner operations, and see balances, payments, the ledger,
statements and the treasury.

## Pages

| Page                                  | What it's for                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview                              | Balances across agents, pending approvals, recent payments, alerts                                                                            |
| Agents                                | Accounts and pocket balances, sessions, mandates, private proofs (disclosure, enrollment, reservations, roots), freeze and unfreeze, payments |
| Policy editor                         | Form and JSON views, a live diff labelling each change as tightening or loosening, the owner signature and 1-hour delay for loosening         |
| Approvals                             | Passkey decisions with the 15-minute countdown and the rule hits behind each request                                                          |
| Payments, Ledger                      | Filterable payments with decisions and ledger lines; monthly statements with CSV                                                              |
| Owner operations                      | Everything waiting for the owner key, signed in the browser                                                                                   |
| Treasury                              | Treasury account, auto top-up, vaults; the treasury sweep shows as gated on counsel sign-off                                                  |
| Webhooks, API keys, Billing, Settings | Endpoints and events, keys, plan and fees, members, passkeys, owner-key rotation                                                              |
| Staff revenue                         | Revenue by stream against the design's Beta/Growth/Scale model (staff only)                                                                   |

## How it works

The browser only talks to the console. Route handlers under `/api/*` proxy to the API with the
user's credential from a sealed, httpOnly `__Host-` cookie (passkey session, or an org API key in
sandbox mode). Every page gets a per-request nonce CSP and `X-Frame-Options: DENY`; mutating
requests need a matching Origin and a double-submit CSRF token. Owner signatures happen in the
browser with an injected wallet, or a clearly labelled testnet key in sandbox mode, and never
reach the server.

## Run

```bash
pnpm --filter @agentbank/api dev:local      # the API with a simulated chain on :8080
NEXT_PUBLIC_SANDBOX=true pnpm --filter @agentbank/console dev   # http://localhost:3000
pnpm --filter @agentbank/console test
pnpm --filter @agentbank/console build      # standalone output for the container image
```

| Variable                  | Meaning                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `AGENTBANK_API_URL`       | API base URL (default `http://localhost:8080` in development)        |
| `CONSOLE_SESSION_SECRET`  | ≥ 32 characters; seals session cookies (required in production)      |
| `CONSOLE_ORIGIN`          | Allowed origins for the CSRF check (match the API's WebAuthn origin) |
| `NEXT_PUBLIC_SANDBOX`     | Enables sandbox sign-up, API-key sign-in and the testnet owner key   |
| `STAFF_DASHBOARD_ENABLED` | Enables the staff revenue view                                       |
| `COOKIE_SECURE`           | Secure cookies (on by default in production)                         |
