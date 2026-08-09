# ADR 0011 — Partitioned asynchronous architecture

- **Status**: Accepted — **built through N5B** (phases N2–N5B; N6 measurement pending). The original status line said "nothing below exists yet"; that stopped being true one phase at a time, and this header was the last to notice.
- **Date**: 2026-08-09

> **As-built resolution (2026-08-09, after N5B).** The architecture below was
> built with three deliberate deltas, each decided in its own ADR rather than
> discovered:
>
> 1. **Worker presence is process memory, not Redis-lazy.** The worker reads
>    memory → Postgres; cold reads never touch Redis
>    ([ADR 0018](0018-worker-local-presence.md)). The "worker-local presence
>    rejected for v1" alternative below was un-rejected by static partition
>    ownership ([ADR 0016](0016-worker.md)) — exclusive ownership removed the
>    split-brain that justified the rejection; the rebalance-fencing caveat now
>    lives with N5-final's rebalancing work.
> 2. **Area invalidation is version polling only.** The "publish an
>    invalidation" channel was never built — N2 chose the 30 s poll as the
>    whole mechanism, not the self-healing backup
>    ([ADR 0012](0012-in-memory-spatial-index.md)); pub/sub remains unbuilt and
>    unneeded at current staleness budgets.
> 3. **Dedup state lives in worker memory over a read-only table** — the
>    per-event write is gone as promised, but the checkpoint writes this ADR's
>    consequences section anticipates are N5-final work, not built
>    ([ADR 0016](0016-worker.md)/[0017](0017-per-user-parallelism.md)).
>
> Everything else stands as designed: 202/stateless API with publisher
> confirms ([ADR 0015](0015-publisher-contract.md)), fixed 256 partitions keyed
> `hash(userId)` ([ADR 0014](0014-rabbitmq-topology.md)), ack-after-commit,
> advisory lock + `ON CONFLICT` under the ~1% change path, `receivedAt` as
> `recorded_at`. The text below is preserved as the design record.

## Context — a scope change, not a correction

The synchronous system answers the case at the scale it was measured
(~1,600–2,000 req/s one box, Node the wall, Postgres nearly idle) and every
measurement behind it stands. The target moved: millions of location events per
day across many app instances. At that scale the premises under ADR 0004 and
ADR 0007 stop holding — not because they were wrong, but because they were
scoped to a smaller question. Two independent reviews converged on the same
diagnosis: the durable argument against a queue was never "log writes are rare"
(ingestion scales with events, not logs), and once Postgres stops being idle,
every per-ping round trip is a shared-resource cost that horizontal scaling
multiplies. ADR 0004 and ADR 0007 are superseded with their reasoning and
numbers intact; ADR 0003's "until measured" clause resolved via the stub
measurement.

## The architecture

Adaptive mobile clients (≥10 s since last send, ≥50 m moved, usable accuracy —
ADR 0010) → a **stateless API** that validates, stamps `receivedAt`, publishes
to a partitioned queue, and returns **202 Accepted** — no database touch, no
transition result → **a queue with a FIXED partition count of 256**, keyed
`hash(userId)` → **workers, each owning several partitions**, processing one
user's events in order while different users proceed in parallel.

Per event, a worker: deduplicates on `(deviceId, seq)`; computes containing
areas from an **in-memory versioned polygon snapshot** (PostGIS stays source of
truth and `POST /areas` validator; it is no longer the per-ping decision
engine); resolves previous membership **Redis → Postgres, lazily**; and then
the fork that carries the design — **if membership did not change, it does
nothing at all and acknowledges** (~99% of traffic). Only on a change does it
produce an ENTER/EXIT business event and write presence + log to Postgres in
one transaction. **Acknowledgement happens only after commit**, so a worker
dying mid-transition means redelivery from a clean state — the same
idempotence/atomicity the synchronous path proved (trigger-forced rollback
test; `ON CONFLICT` absorbing replays) makes redelivery safe.

**The advisory lock stays**, although partitioning already serialises per user:
a rebalance window can briefly give two workers the same partition, and the
database remains the final arbiter regardless of what the message layer
promises.

**Area changes**: `POST /areas` writes to Postgres, bumps an area version, and
publishes an invalidation; workers reload the snapshot, with periodic version
polling as the self-healing path when the notification is missed.

## The correctness carry-over that must not be lost

ADR 0002's addendum requires any presence cache to answer the stale-hit hole
(a stale set containing an area the database lacks suppresses a genuine
re-entry). The target reads presence *outside* the lock — which is what makes
the cache viable — and answers the hole where it is cheap: **on the ~1% change
path, the worker re-verifies presence authoritatively inside the locked
transaction before writing.** The fast path trusts the cache because a wrong
"no change" is corrected by the next event that differs; the write path never
trusts it, because writes are where a stale read becomes a lost log. This is
the verify-on-hit ADR 0007 named as the missing machinery, purchasable now
because only ~1% of events pay it.

## What each layer scales with

| Layer | Scales with | Shared resource removed from the per-event path |
| --- | --- | --- |
| Stateless API | instances (no DB, no state) | Postgres connections |
| Queue | partitions (fixed 256) | — (absorbs bursts instead of shedding them) |
| Workers | worker count (≤256 useful) | PostGIS execution (in-memory PIP) |
| Redis | presence read rate | Postgres reads on the 99% path |
| Postgres | **membership changes only** (~1% of events) | — the point of the fork |

## Alternatives considered and rejected

- **A queue per user** — rejected: a million users is a million queues;
  creation, discovery, and rebalancing all scale with population. A fixed 256
  partitions keyed by `hash(userId)` preserves the only property per-user
  queues offered — same user, same lane, in order — at O(1) queue count.
- **One worker per partition** — rejected: couples worker count to partition
  count (256 workers or idle partitions), and makes scaling a repartitioning
  event. Ownership of several partitions per worker keeps partition count a
  layout constant while worker count follows load.
- **Worker-local presence state in v1** — rejected *for the first version*:
  fastest option, most fragile — a restart loses it, and a rebalance can leave
  two workers holding different pictures of the same user (split-brain on the
  exact state the system exists to track). Redis → Postgres lazy resolution
  first; worker-local becomes a later refinement once rebalance fencing exists
  (revisit condition in SCOPE).
- **Redis as authoritative presence** — rejected permanently: ADR 0002's four
  failure modes (expiry, non-atomic RMW, multi-instance races, state/log
  divergence) are scale-independent. Redis remains a cache over Postgres
  truth, never the truth.
- **Keeping the synchronous request path and just scaling it out** — the
  honest baseline, measured and documented; rejected at target scale because
  every ping pays Postgres round trips and the pool arithmetic
  (`N × pool ≤ max_connections`) caps N regardless of app-tier capacity.

## Consequences

- The response contract changes when N4 lands: `POST /locations` returns
  **202 Accepted** with no transition result — clients learn of entries via
  `GET /logs`. Decision 11's 201-with-`enteredAreaIds` remains the contract of
  the synchronous system until then.
- `receivedAt` is stamped at the API and carried through the queue; it becomes
  the `recorded_at` written by workers, preserving decision 8's semantics under
  backlog (entry time = receipt, not processing).
- Dedup state (ADR 0010's `user_event_state`) moves toward per-partition worker
  memory with the table as durable checkpoint — removing the per-ping write the
  synchronous dedup accepted.
- Postgres write volume decouples from event volume: it scales with membership
  changes (~1%), which is what makes "millions of events per day" a queue-depth
  number rather than a database number.
- None of this exists yet. The phase table in CLAUDE.md (N2–N6) is the build
  order; every claim above is design intent until its phase ships a
  measurement.
