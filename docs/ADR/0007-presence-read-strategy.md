# ADR 0007 — Presence read strategy: folded lock+read wins

- **Status**: Accepted — closed by measurement (docs/PRESENCE_READ_MEASUREMENT.md)
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

**`folded` is the default.** Measured under closed-loop load (10/50/200/500
in-flight, 10,000 users, both workload shapes — full method, curves and caveats
in docs/PRESENCE_READ_MEASUREMENT.md):

- `folded` beat `two-step` by **+15–20% throughput with lower p50/p95/p99 at
  every concurrency level in both workloads** (e.g. static c=500: 1,605 vs
  1,393 req/s; transition c=500: 1,394 vs 1,230 req/s) — almost exactly the one
  removed round trip out of ~5.
- `cache` was **measured and not adopted**: +7% over baseline in the static
  workload at a 99.7% hit rate, but **−13 to −18% below baseline in the
  transition-heavy workload** (hit rate 0.50–0.78, DEL+SET churn, and the Redis
  hop sitting inside the locked transaction). The cache-under-lock correctness
  requirement (ADR 0002) removes the "release the connection sooner" benefit a
  cache would normally buy; Redis server-side latency (2–3 µs/command) was
  never the problem — the hops were.
- The pool never became the constraint (10 connections, mostly idle-in-
  transaction; zero errors at every level); the app tier saturates first at
  ~1.3–1.6 k req/s on this box.

The `cache` and `two-step` paths and the `PRESENCE_READ_STRATEGY` flag are
**kept, not deleted**: the decision is recorded with evidence and stays
reversible with a flag flip, not a rebuild.

Precision about what a topology change can and cannot change: the cache read
must happen under the advisory lock, and the lock is acquired **in Postgres** —
so the cache never removes a Postgres round trip; it adds a Redis one on top:

    folded:      lock + presence read in ONE Postgres round trip
    cache hit:   lock (a Postgres round trip) + a Redis round trip

On a remote database both paths pay the same Postgres latency and the cache
still pays Redis on top. What rising database latency actually changes is the
comparison against `two-step`, whose presence read is its own second Postgres
round trip — there the cache does win as latency rises. **A remote database
makes the cache beat `two-step`, not `folded`.** The condition under which the
cache would beat `folded` is different: the lock itself would have to move off
the hot path (a different concurrency design), which this design deliberately
does not do.

Conditions and limits: single box (Windows/WSL2 Docker), localhost networking,
synthetic uniform load, default pool of 10, 12 s windows. The ranking argument
is architectural and should transfer; the absolute numbers should not.

## Consequences

- Default `PRESENCE_READ_STRATEGY=folded` (Joi default, `.env.example`, README).
- Three code paths remain in `LocationsService.lockAndReadPrevious` behind the
  flag; the full e2e suite runs under any of them via the env var.
- The plpgsql function `lock_user_and_read_presence` is now on the hot path;
  its lock-before-read ordering is documented plpgsql semantics, verified by
  the blocking experiment recorded in this ADR's Candidates section.
- Revisit trigger, stated precisely: a remote database re-opens **`cache` vs
  `two-step` only** — `folded` keeps its lead at any Postgres latency, because
  both pay the lock's Postgres round trip and the cache adds Redis on top.
  Re-run `scripts/measure-presence.mjs` and re-decide if `folded` itself ever
  becomes unavailable (e.g. an environment that cannot ship the plpgsql
  function), if the lock design changes such that the lock leaves the hot
  path, or on a measured pool-contention regime.
