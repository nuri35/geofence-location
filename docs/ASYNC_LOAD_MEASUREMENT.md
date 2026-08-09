# Async pipeline load measurement (N6, first run — 2026-08-09)

Point-in-time record; annotate, never rewrite. Raw rows live in the session
transcript; the harness is `scripts/measure-presence.mjs` (`measure` mode).

## Conditions — stated with every number

One box (AMD Ryzen 9 5900HX, 8c/16t, 31.4 GB), everything sharing it: closed-loop
load generator, API (`node dist/main`), worker(s) (`node dist/worker-main`),
Postgres/Redis/RabbitMQ under Docker/WSL. Dev topology: **8 partitions**, 10k
users, 12 s per point (2 s warmup), workloads `static` (all no-change) and
`transition` (~half flip membership). ABBA bracketing: A = 1 worker (p0–7),
B = 2 workers (p0–3 / p4–7), order A1 B1 B2 A2, workers restarted between arms.
Tracer poll floor 25 ms. Consumer counts verified before trusting queue numbers.

## The three headline numbers

1. **Queue buffering** — steady-state overload never formed a backlog (static
   ingest plateaus at **4.6–5.0 k req/s**, the API ceiling, with the queue at
   0–61 deep). What formed backlogs — three episodes — was **Postgres-side
   stalls** (maxXact 2.3–10.6 s, a recurring checkpoint/WSL-fsync-shaped
   signature): worst case **13,709 messages deep, growing at 1,162 msg/s**
   (A1, transition c=200), API unaffected throughout (0 errors, p50 55 ms),
   fully drained within ~14 s of load stop. The closing control (A2, identical
   config) kept the queue at max 12 at near-identical ingest: **the backlog
   edge sits at one worker's transition capacity (~2.5–3.1 k events/s on this
   box) and DB-stall timing decides which side of it a run lands on.**

2. **Worker scaling** — two workers on disjoint halves gained **no throughput**
   over one (2.6–3.2 k/s vs 3.1–3.6 k/s transition; a slight loss): on one box
   the second worker competes with the API — the actual bottleneck — for CPU
   and Postgres. Backlog peaks under comparable stalls were 1–2 orders smaller
   with two workers (174/232 vs 11–13.7 k), though not prevented (B2 c=50
   spiked to 6,432 and absorbed it mid-run). Disjoint consumption itself was
   flawless: zero errors, zero tracer timeouts, all arms. **Linear scaling is
   untestable with workers on the API's box** — the open N6 item.

3. **End-to-end latency (202 → log row visible)** — healthy: entry **p50
   2–30 ms** (values of ~26–29 ms are one tracer poll tick; true latency is at
   or below the 25 ms instrument floor), **p99 30–130 ms** at every
   concurrency. Under the 13.7 k backlog: p50 ~400 ms, **p99 4.1–4.4 s**,
   recovering as the queue drained. This is the eventual-consistency contract
   in numbers: milliseconds normally, seconds under a burst, bounded by
   backlog ÷ drain rate.

## The ADR claims

- **ADR 0011 — "the queue buys decoupling and burst absorption, not
  throughput": held.** During every backlog episode API latency and error rate
  were indistinguishable from healthy runs; the deferred work drained at
  ≥ ~1 k/s afterward. End-to-end transition throughput matched what Postgres
  could always do — the queue moved work in time, it did not shrink it.

- **ADR 0018 / decision 23 — "~99% of events ack without touching any
  database": held in mechanism; the share is unmeasurable from outside and
  remains a traffic assumption** (the harness header says exactly this — a
  synthetic workload chooses the share rather than measures it). The substance
  is proven: at 4.6–5.0 k/s of no-change traffic, pool `avgActive` was
  0.03–0.95 and the queue stayed empty — the fast path touches no database.

## Instrument caveats found this run

- **`drainAfterLoadMs` undercounts.** It starts after the tracers finish their
  up-to-15 s timeouts, during which the worker is already draining — the
  13,709 backlog printed as a 657 ms "drain". Read it as the drain *tail*;
  bound the true drain by the tracer window until the harness times from
  load-end.
- Healthy-state e2e p50 is floor-limited by the 25 ms tracer poll; values at
  the floor mean "at or faster than the instrument", not a measured 26 ms.
- Everything shares one box: run-to-run drift up to ±15–20 % (known since N2)
  moved ingest across the worker-capacity edge between A1 and A2 — single
  windows lie; only the bracketed comparison above is quotable.
