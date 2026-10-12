# 0010: Rolling policy windows

- Status: Accepted
- Date: 2026-10-11

## Context

Per-day, per-week and per-month limits can be calendar windows or rolling windows. Calendar
windows let an agent spend twice the daily cap across midnight.

## Decision

The off-chain policy engine uses rolling windows (24 hours, 7 days, 30 days). The on-chain
hook uses UTC-day buckets (cheap to compute in Solidity), which are always looser than or equal
to the rolling window, so the off-chain engine is the tighter of the two layers.

## Consequences

- Documented in the policy editor so principals are not surprised.
