# ADR 0007 — Presence read strategy (decision pending measurement)

- **Status**: Proposed — to be closed by the Phase 4 measurement task
- **Date**: 2026-08-07

## Context

Every `POST /locations` needs the user's previous membership under the advisory
lock. Phase 2 measured the presence read at 0.013 ms on the primary key, on a
connection already checked out for the transaction — which undercuts the usual
case for a cache. Phase 2's report also noted the lock and the read are two
separate round trips that could be one. Two candidate optimisations point in
opposite directions; both are now built and switchable via
`PRESENCE_READ_STRATEGY`, so the same load can run against each.

## Candidates

- **`two-step` (baseline)** — `SELECT pg_advisory_xact_lock(...)`, then the
  presence `SELECT`. Two round trips, no moving parts. The Phase 2 behaviour.
- **`folded` (Path A)** — one round trip via the plpgsql function
  `lock_user_and_read_presence(uid)`. The fold is a function, **not** a
  same-statement combination, because of a verified failure: with the lock held
  by another session, `EXPLAIN ANALYZE` of the InitPlan-style single statement
  under a **seq scan plan on an empty table** showed
  `Function Scan on pg_advisory_xact_lock ... (never executed)` — execution
  time 0.031 ms, no blocking, **lock silently skipped**. The same statement
  under the bitmap-index plan blocked correctly (10.6 s server-side), proving
  the ordering is a plan artifact, not a guarantee. plpgsql statement order IS
  documented semantics, and the function version blocked 11.7 s server-side in
  the same adversarial case.
- **`cache` (Path B)** — Redis read-through in front of the presence read,
  consulted only under the lock (ADR 0002, cache-under-lock). Value is a JSON
  string array, `"[]"` = known-empty; miss populates, error does not; state
  changes invalidate inside the transaction and again after commit.

## What the measurement must weigh

`folded` removes one round trip unconditionally. `cache` replaces a Postgres
PK read (0.013 ms execution) with a Redis network hop — **while holding the
per-user lock**, so any Redis latency stretches the serialized window — and
adds populate/invalidate traffic on transitions. The cache's case rests on
Postgres round-trip/pool contention at load, not on raw read cost.

## Decision

Open. The measurement task closes it; the losing paths and the
`PRESENCE_READ_STRATEGY` flag are then removed — the switch is scaffolding for
this decision, not a feature.

## Consequences (of the measurement scaffolding itself)

- Three code paths temporarily coexist in `LocationsService.lockAndReadPrevious`;
  the full e2e suite runs under any strategy via the env var.
- The plpgsql function ships as a migration and stays regardless of outcome
  (dropping it is a one-line migration if `folded` loses).
