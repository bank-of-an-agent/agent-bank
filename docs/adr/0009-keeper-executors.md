# 0009: Keeper-triggered executors for top-up and sweep

- Status: Accepted
- Date: 2026-10-11

## Context

Auto top-up (treasury → agent) and the treasury sweep (account ↔ tokenized fund) need to run
without the agent or the owner signing each time, yet Agent Bank must never be able to move
funds anywhere the owner did not choose.

## Decision

Both run as ERC-7579 executor modules that the owner installs and configures with an owner
operation (`TopUpExecutor`, `SweepExecutor`). Anyone (in practice an Agent Bank keeper) may call
them, but they can only move funds between the principal's own accounts (treasury → its agent
accounts) or between an account and the single allowlisted fund contract, within the
configured limits.

## Consequences

- Triggering is permissionless and therefore not a privileged bank power.
- The treasury sweep stays disabled (`FEATURE_TREASURY_SWEEP`) until counsel signs off on
  broker and adviser questions.
