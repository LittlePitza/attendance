# ADR-0001 — Everything in Supabase, no application server

- **Date:** 2026-08-24
- **Status:** Accepted
- **Scope:** the whole architecture

## Context

The initial design called for a Python engine that would receive punches, apply
the business rules and write to the database. The company already runs a
Supabase project (`pimsa_ti`) in production with the IT help desk.

While verifying the documentation, one fact settled the matter: **Supabase Edge
Functions only run TypeScript on Deno. There is no Python runtime.** Keeping
Python would have meant hosting a separate application server.

## Decision

Business rules live **inside Postgres**, in `SECURITY DEFINER` functions. Edge
Functions are limited to talking to the outside world (email, user provisioning,
exports) and hold no rules. The PWA has no logic: it calls functions and renders
data.

## Rationale

**It does not lower security; it raises it.** With an application server there
is a component that *can* be bypassed: anyone holding a valid token can hit
Postgres's REST API directly and skip the engine's rules. Here that is
impossible, because `authenticated` is granted **no** write privilege on any
table. The function is the only way in, and the function validates.

**The timestamp comes from the database's own clock**, not from an intermediate
process that could be out of sync or swapped out.

**Fewer moving parts to operate.** No server to deploy, monitor, patch or pay
for. The PWA is static files.

## Accepted cost

We give up Python's reporting ecosystem — `pandas`, `openpyxl`. Generating XLSX
in Deno means SheetJS and is less convenient. It is the only real cost and it
falls outside the core.

Logic in `plpgsql` is less readable than in Python. That is offset by
`COMMENT ON` on every function, this decisions directory, and the tests in
`supabase/tests/sql/`, which double as a living specification.

## Consequences

- Every function carries `SET search_path = ''` and fully qualified names.
  Without that, a manipulated `search_path` allows hijacking it.
- The `internal` and `attendance` schemas are **not** exposed through the API.
- The alert evaluator is plain SQL on `pg_cron`: it never leaves the database,
  so it consumes no Edge Function invocations — which matters on the Free plan.
- Verifying any change requires testing SQL, not just TypeScript.
