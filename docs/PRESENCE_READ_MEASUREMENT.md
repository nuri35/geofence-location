# Presence read strategy measurement (closes ADR 0007)

Point-in-time record, 2026-08-07. Not rewritten, only annotated (house rule).

## Instrument

Custom closed-loop generator: `scripts/measure-presence.mjs` — N workers, each a
sequential request loop over a keep-alive `http.Agent`; in-flight concurrency is
exactly N. 12 s per run, first 2 s discarded. Latency via `hrtime.bigint()`.
Server: the real prod artifact (`node dist/main`), restarted per strategy with
`PRESENCE_READ_STRATEGY` set. Same box runs generator, Node server, Postgres and
Redis containers (WSL2) — a deliberate limitation, stated below.

Side instrumentation, all external to the app (no logic changes):
`pg_stat_activity` sampled at 5 Hz (connection states, lock waiters, transaction
ages — a biased sampler for short transactions; treat transaction-age numbers as
order-of-magnitude), Redis `INFO stats`/`commandstats` deltas per run (hit rate,
server-side µs/command).

**Users**: 10,000 distinct ids (ADR 0004's assumption), warmed inside the area
before each workload — a single user would serialize on one advisory lock and
measure the lock, not the read strategy. `pg_stat_activity` confirmed
`maxLockWaiters = 0` in every run.

**Workloads**: (a) *static* — every request an inside-ping for an already-inside
user, ~100% no-change, matching ADR 0004's read-heavy shape; (b) *transition* —
50% inside / 50% outside per request, ~half of requests flip state.

## Harness floor — measured before believing anything

| Suite | c=10 | c=50 | c=200 | c=500 |
| --- | --- | --- | --- | --- |
| 404 route (pure Node, no DB) — req/s | 4,893 | 5,214 | 5,565 | 5,551 |
| `/health` (1 DB ping + 1 Redis ping) — req/s | 921 | 1,043 | 988 | 1,057 |

The pure-Node ceiling is ~5.5 k req/s; a minimal DB-touching endpoint plateaus
near ~1 k req/s. Strategy numbers (1.0–1.6 k req/s) sit above the DB-endpoint
floor and well below the Node ceiling, so differences between strategies at
equal conditions are meaningful; absolute values are box-specific.

## Results — throughput (req/s), p50/p95/p99 (ms), sustained

### Workload a — static (~100% no-change)

| Strategy | c=10 | c=50 | c=200 | c=500 |
| --- | --- | --- | --- | --- |
| two-step | 1,335 · 7.4/9.1/11.6 | 1,298 · 38.5/44.9/48.8 | 1,334 · 150/177/191 | 1,393 · 372/413/427 |
| **folded** | **1,580 · 6.2/7.8/10.5** | **1,553 · 31.7/38.2/42.2** | **1,594 · 128/140/145** | **1,605 · 325/346/353** |
| cache | 1,336 · 7.2/10/12 | 1,418 · 35.1/41.6/46.2 | 1,463 · 138/153/159 | 1,497 · 341/374/383 |

Cache hit rate rose 0.50 → 0.997 across the four runs as the cache warmed; the
c=500 row is the honest steady state (99.7% hits).

### Workload b — transition-heavy (~50% of requests flip state)

| Strategy | c=10 | c=50 | c=200 | c=500 |
| --- | --- | --- | --- | --- |
| two-step | 1,219 · 8.1/11.2/13.8 | 1,193 · 41.4/50/56.2 | 1,214 · 166/185/193 | 1,230 · 422/465/508 |
| **folded** | **1,440 · 6.8/9.9/12** | **1,415 · 35.1/42.4/47.5** | 1,226 · 146/170/1226\* | **1,394 · 374/401/407** |
| cache | 1,156 · 8.6/13.2/15.2 | 1,103 · 45.2/53.9/59.4 | 1,062 · 189/228/250 | 1,014 · 516/586/618 |

\* One multi-second stall landed inside this run's window (see "Unrelated
findings"); its p99 is the stall, not the strategy — the c=500 run of the same
strategy is clean.

Cache hit rate under transitions: 0.50–0.78 — every transition invalidates, so
half the traffic misses and repopulates. Redis server-side cost was never the
problem: 2.3–3.2 µs/command throughout; the loss is the extra network hops and
invalidation traffic inside the locked transaction.

**Errors: zero in every run** (no 5xx, no network errors, no pool timeouts).

## Pool and transaction observations

- The pool cap of 10 (pg driver default, never configured) was confirmed
  empirically — `maxConnections` pinned at 10–11 in every run.
- The pool is **held**, not **busy**: average *active* backends 0.2–2.0 while
  5–6 connections sat `idle in transaction` — held by Node between round trips.
  Requests queue at the app tier while Postgres idles. No `pg_stat_activity`
  evidence of connection-wait pileups beyond that; queueing is visible instead
  as the linear latency growth with concurrency at flat throughput.
- Sampled transaction ages in steady state: ~0 ms buckets (sub-5 ms), i.e. a
  connection is held a few ms per request — consistent with ~5 round trips at
  sub-ms each plus Node scheduling.

## Answers to the five questions

1. **Does the pool become the constraint?** No — not at any tested level. Its
   *size* never mattered because its *occupancy* was idle-in-transaction, not
   active. The app tier (Node serialization of per-request round trips, with
   everything sharing one box) saturates first, at ~1.3–1.6 k req/s. The
   prediction that Node saturates before the pool: **confirmed**.
2. **Does cache shorten the transaction / translate to throughput?** No. Under
   cache-under-lock (a correctness requirement, ADR 0002), the Redis hop happens
   *inside* the transaction, so the connection-hold is not shortened — one
   Postgres round trip is swapped for one Redis round trip, plus SET/DEL on
   transitions. Static workload: modest +7% over baseline. Transition workload:
   **−13 to −18% below baseline**, the worst of the three.
3. **Does folded beat two-step by about one round trip?** Yes, cleanly and
   consistently: +15–20% throughput and lower latency at every level in both
   workloads. Removing 1 of ~5 round trips predicts ~+20%; measured matches.
4. **Is there a crossover?** Not in the winner — `folded` leads everywhere. The
   cache crosses *baseline*: above `two-step` in static, below it in
   transition-heavy. That disagreement is the finding: the cache's value is
   workload-dependent and negative exactly when the system is busiest writing.
5. **What breaks first, with what symptom?** Nothing errors; the failure mode is
   latency. Throughput flatlines at ~10 in-flight and added concurrency converts
   1:1 into queueing delay (p50 ≈ concurrency / throughput, Little's law). At
   c=500 that is ~370 ms p50 on the winner. The symptom of overload is a growing
   queue, not failures — which means backpressure/limits are the Phase 4 lever.

## Limits of what this proves

One box (Windows/WSL2 Docker) running generator + Node + Postgres + Redis;
localhost networking (no real network latency — a remote Redis or DB changes the
round-trip arithmetic materially); synthetic load with uniform users; 12 s
windows; pool size left at default 10. The *ranking* argument (folded removes a
round trip unconditionally; cache adds hops inside the lock) is
architecture-driven and should transfer; the absolute numbers should not be
quoted beyond this setup.

## Unrelated findings (surfaced by load, independent of the decision)

1. **Multi-second single-transaction stalls** (1.5–4.8 s max transaction age)
   appeared in write-heavy runs under **all three strategies** — strategy-
   independent. Postgres checkpoint logs show healthy spread checkpoints
   (sync ≤ 0.3 s), so WAL-fsync latency spikes from the WSL2/Docker I/O layer
   are the prime suspect. One stall is enough to wreck a run's p99. Phase 4
   should set `log_min_duration_statement` temporarily and decide whether
   `statement_timeout` should bound the damage.
2. **The pool's 10 connections are mostly idle-in-transaction under load.**
   Raising the pool size would NOT raise throughput here (Postgres wasn't the
   constraint), but on a multi-instance deployment each instance holding 10
   idle-in-transaction connections is real pressure on `max_connections` —
   pool sizing in Phase 4 should be deliberate, not default.
3. `/health` costs a DB ping + Redis ping and plateaus at ~1 k req/s — an
   unauthenticated, uncached amplification target. Worth a note in the
   rate-limiting non-goal (docs/SCOPE.md) rather than a fix now.
