# Agent Bank x402 facilitator

Verifies and settles payer-signed [x402](https://x402.org) `exact` payments (EIP-3009
`transferWithAuthorization` on USDC) for sellers that charge per call. Sellers point their x402
middleware (for example the SDK's `createPaywall`) at `<facilitator>/v1/x402`.

## Endpoints

| Route                          | Purpose                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `POST /v1/x402/verify`         | Validate a payment against the requirements (x402 v2 shapes)                          |
| `POST /v1/x402/settle`         | Verify again, record the authorization as single-use, submit it, wait for the receipt |
| `GET /v1/x402/supported`       | Schemes, networks, relayer address and `settleBeforeServeAbove`                       |
| `GET /healthz`, `GET /metrics` | Health (incl. relayer gas) and Prometheus metrics                                     |

Checks include network and asset, payee and exact amount, validity window (at least 6 seconds
left, not longer than `maxTimeoutSeconds` + 60), the EIP-712 signature exactly as USDC v2.2
judges it (ECDSA for EOAs, ERC-1271 for contracts, `payer_has_code` for delegated EOAs),
on-chain and local nonce use, payer balance, and sanctions screening (fail closed). Each
authorization settles at most once even under concurrent requests or several instances.

## Run

```bash
pnpm --filter @agentbank/facilitator dev
pnpm --filter @agentbank/facilitator test   # 203 tests, incl. interop with @x402/core's facilitator client
```

| Variable                                                                                   | Meaning                                                                               |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `PORT` (8083), `DATABASE_URL`                                                              | Listen port; PostgreSQL (shares the API database, table `x402_authorization`)         |
| `X402_NETWORK` / `AGENTBANK_CHAIN`, `CHAIN_RPC_URL`                                        | Network (Base Sepolia, Anvil or simulated) and RPC                                    |
| `FACILITATOR_RELAYER_KEY`                                                                  | Testnet relayer that pays gas (never logged; mainnet refused)                         |
| `FACILITATOR_PAYEE_MODE`                                                                   | `any` (sandbox) or `registered` (only Agent Bank x402 payees; required in production) |
| `RATE_LIMIT_VERIFY_PER_MINUTE`, `RATE_LIMIT_SETTLE_PER_MINUTE`, `MAX_INFLIGHT_SETTLEMENTS` | Abuse limits per client IP                                                            |
| `RELAYER_MIN_BALANCE_WEI`                                                                  | Refuse to settle when the relayer is low on gas                                       |
| `TRUST_PROXY`                                                                              | Proxy hops to trust (`1` behind the ALB)                                              |
| `SCREENING_PROVIDER`, `SCREENING_DENYLIST`                                                 | Sanctions screening (sandbox denylist by default)                                     |
| `MAX_SETTLEMENT`, `SETTLE_BEFORE_SERVE_ABOVE`                                              | Guards (default settle-before-serve above $1.00)                                      |
