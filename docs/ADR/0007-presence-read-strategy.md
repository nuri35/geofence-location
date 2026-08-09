# ADR 0007 — Presence read strategy: folded lock+read wins

- **Status**: Superseded by [ADR 0011](0011-partitioned-async-architecture.md) for the target architecture (2026-08-09); remains the governing decision for the synchronous system as built
- **Date**: 2026-08-07

> **Supersession note — the constraint moved; the measurement did not.** The
> cache lost here for a precise mechanical reason: correctness required the
> cache read to sit *inside the locked transaction* (cache-under-lock, ADR
> 0002), so a Redis hop was added on top of the Postgres round trip it was
> meant to replace, and invalidation churn collapsed the hit rate under
> transitions. In the target architecture the worker resolves previous
> membership Redis→Postgres *before* opening any transaction — the read is no
> longer under the lock, which removes exactly the mechanism that made the
> cache lose. The correctness finding (a stale hit can suppress a genuine
> re-entry) was real and remains binding: ADR 0011 answers it by re-verifying
> presence authoritatively under the lock on the ~1% change path, which is the
> "verify-on-hit" this ADR said would be required. Numbers, method, and the
> folded decision for the synchronous system all stand.

> **Resolution (2026-08-09, Phase N3 — [ADR 0013](0013-presence-cache-no-change-fast-path.md)).**
> The constraint that made the cache lose is gone and the measurement now says
> the opposite, for the reason this note predicted: read OUTSIDE the lock, the
> cache no longer adds a hop on top of the lock's round trip — it removes the
> transaction entirely on the ~99% no-change path. Measured under ABBA
> bracketing: **static +56–104% (2,9k → ~5,1k req/s, Postgres untouched)**;
> transition −8 to −28% (the 50%-flip workload is the cache's worst case) —
> bought deliberately for the real traffic shape. The correctness finding of
> this ADR remains binding and is now answered with machinery, not hope:
> verify-under-lock on every write, invalidate-after-commit, and a TTL bounding
> the stale-"unchanged" suppression this ADR identified — provoked and measured
> in `test/stale-presence.e2e-spec.ts` (entry lost while stale; recovered by
> TTL or by any differing sample). The folded function stays as the change
> path's one-round-trip authoritative read.

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

**`folded` is the implementation — the cache and the two-step baseline were
removed after losing.** Measured under closed-loop load (10/50/200/500
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

The `cache` and `two-step` paths and the `PRESENCE_READ_STRATEGY` flag were
initially kept behind the flag for reversibility, then **removed entirely**
(same day) for a second, independent reason found in review: **the shipped
cache path had a correctness hole.** Cache invalidations are best-effort
(swallowed on failure) by design; a Redis outage spanning a transition
therefore loses both the in-transaction and post-commit invalidations. After
recovery the stale key is served as a *hit under the lock* and used as
`previous`. The phantom-entry direction is absorbed by `ON CONFLICT`, but the
suppression direction is not: a stale set containing an area the database no
longer has suppresses the entry log when the user re-enters, until some
differing sample heals the key. That falsifies "losing Redis costs latency,
never correctness" for the cache path; fixing it needs verify-on-hit or TTL
semantics — machinery not worth building for a path the measurement had
already rejected. The cache was a reasonable hypothesis, tested properly, and
rejected on two independent grounds; reversibility now lives in this ADR, the
measurement document, and git history rather than in dormant code. The Redis
infrastructure (compose service, client module, health probe, env vars) left
with it — nothing else used Redis.

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

- `LocationsService` has exactly one presence-read path; the strategy flag, its
  config surface, the cache service, and the Redis infrastructure are gone.
- The plpgsql function `lock_user_and_read_presence` is the hot path;
  its lock-before-read ordering is documented plpgsql semantics, verified by
  the blocking experiment recorded in this ADR's Candidates section.
- Revisit trigger, stated precisely: a remote database re-opens **`cache` vs
  `two-step` only** — `folded` keeps its lead at any Postgres latency, because
  both pay the lock's Postgres round trip and the cache adds Redis on top.
  Re-run `scripts/measure-presence.mjs` and re-decide if `folded` itself ever
  becomes unavailable (e.g. an environment that cannot ship the plpgsql
  function), if the lock design changes such that the lock leaves the hot
  path, or on a measured pool-contention regime.
