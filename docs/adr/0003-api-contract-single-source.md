# 0003: The route registry is the API's single source of truth

- Status: Accepted
- Date: 2026-10-11

## Context

The design makes OpenAPI 3.1 the source of truth and wants typed contracts shared with the SDK.
Hand-writing OpenAPI and then re-declaring the same shapes in Fastify handlers and SDK types
invites drift.

## Decision

Every route is declared once in `packages/core/src/api/routes.ts` with Zod 4 schemas for params,
query, body and response, its auth kinds and whether it is idempotent. The API registers exactly
these routes, the SDK derives request/response types from them (`RequestInputOf`, `ResponseOf`),
and `docs/openapi.json` is generated from them (Zod emits JSON Schema 2020-12, which OpenAPI 3.1
uses natively). CI fails if the committed document is stale (`pnpm openapi:check`).

## Consequences

- Changing the API means changing one file; the compiler then points at every handler and SDK
  call that must follow.
- Non-TypeScript clients (the Python SDK) consume the generated document.
