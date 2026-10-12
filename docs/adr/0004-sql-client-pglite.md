# 0004: One SqlClient over node-postgres and PGlite

- Status: Accepted
- Date: 2026-10-11

## Context

The design picks PostgreSQL 16 with serializable transactions. Tests that need a running
server are slow to start and easy to skip locally.

## Decision

`packages/db` exposes a small `SqlClient` (query, transaction with serializable isolation and
retry on SQLSTATE 40001/40P01, exec, close) with two drivers: node-postgres for real servers and
PGlite (Postgres compiled to WASM, in-process) for unit tests and the local sandbox. Both map
`int8` to `bigint` and `numeric` to `string`, so money never becomes a JavaScript number.
`createTestDatabase()` uses PGlite unless `DATABASE_URL` is set; CI sets it, so every database
test also runs against PostgreSQL 16.

## Consequences

- PGlite is single-connection, so it cannot reproduce concurrency anomalies; concurrency tests
  are marked and only meaningful on PostgreSQL (CI).
- Migrations are plain SQL, owned per domain (`0001_ledger`, `0002_core`, …).
