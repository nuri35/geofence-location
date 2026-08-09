# ADR 0017 — Per-user parallelism inside a partition (Phase N5A)

- **Status**: Accepted
- **Date**: 2026-08-09

## Context

N4C shipped prefetch 1, recorded as temporary: one message at a time per
partition means a slow message for one user blocks every other user queued
behind it — head-of-line blocking between users who share nothing. Raising
prefetch naively breaks the other way: two messages for one user processing
concurrently reorder (the advisory lock prevents duplicate logs, not
reordering; an exit processed before its enter leaves wrong state).

## Decision: per-user promise chains

Each message, after parsing, is appended to its user's chain:
`previous.then(process)`. Same user: strictly sequential. Different users:
independent chains, concurrent. The transition logic did not change —
`LocationsService.report()` is byte-identical; this phase changed only what
calls it and when.

**Ack tracking.** Every task closure holds its own delivery and settles it —
ack or nack on its own delivery tag, at its own completion, on the shared
channel. No task can touch another's tag; ack-after-commit stays true
per-message with N in flight (unit-pinned: two users resolving out of order
ack their own messages in completion order).

**Cleanup and the drain race.** A drained chain's map entry is deleted only if
the entry still IS that chain (identity check): if a new message for the same
user arrives while the old tail's cleanup microtask is pending, the map already
holds the NEW chain and the old cleanup deletes nothing. Unit-pinned, including
the race window. The map is therefore bounded by concurrently-active users, not
by every user ever seen.

**Graceful shutdown.** Cancel every consumer FIRST (no new deliveries), then
`Promise.allSettled` over the live chains (each task still acks on the open
channel), then close channel and connection. Closing under in-flight work would
strand half-processed messages into the redelivery path for no reason.

## Prefetch: configurable, default 16 — reasoned, not picked

Prefetch no longer guards ordering; it is purely (a) the in-flight budget per
partition and (b) the redelivery burst after a crash. Bounds that produce 16:

- **Lower bound**: useful concurrency = distinct users among prefetched
  messages. 1 recreates head-of-line blocking; small values starve the chains.
- **Upper bound**: ~99% of messages are fast-path (no DB) and finish in ~a
  millisecond, but change-path messages need a pooled connection — pool size 10
  (ADR 0009). In-flight far beyond what the change path can absorb just queues
  on pool acquire (2 s bound) and converts bursts into nack/redelivery churn.
  And crash exposure is prefetch × partitions unacked redeliveries (dev:
  16 × 8 = 128; prod per worker: 16 × owned partitions).

16 sits between: roughly pool size with headroom for the fast-path majority,
per consumer. It is a knob (`WORKER_PREFETCH`, Joi 1..1000), and N6's load
measurement is the place to move it on evidence.

## A semantic consequence, stated rather than discovered

With prefetch > 1, a nacked message's redelivery can arrive AFTER a newer
same-user message already processed. The dedup Map then drops the redelivery as
stale (`seq ≤ lastSeq`). This is deliberate and consistent with decisions 8/18:
the newer sample already superseded the older one; processing order remains
arrival order, and a dropped stale retry is the transition model working. Under
prefetch 1 the redelivery usually won the race instead — neither behavior is a
correctness change, but the N5A behavior is the honest at-least-once shape.

## Proven

- Unit (11): same-user sequential + cross-user concurrent (start-order pinned
  with controllable promises), own-tag acks in completion order, drain cleanup
  + the re-creation race, shutdown cancel→drain→close ordering.
- e2e — head-of-line: 24 probe users hashed to find 4 sharing ONE partition;
  the first held mid-transaction via its advisory lock (the N4D technique);
  the 3 users queued BEHIND it completed (log rows present) while
  `pg_stat_activity` still showed the advisory-lock waiter — measured: the
  fast users were already logged **2 ms into observation** (first poll after
  worker boot) while the head-of-line message stayed mid-transaction; under
  prefetch 1 they cannot complete before the lock releases, by construction.
  Release, then the slow user completed exactly once.
- e2e — ordering: live worker at prefetch 16, rapid enter → exit → re-enter
  with another user interleaved: exactly two entries, ordered, exit processed
  between, final presence correct.

## What N5B (worker-local presence) must know

- **The execution model it sits inside is now concurrent across users.** Any
  worker-local state keyed by user is safe by construction (the chain
  serializes a user); any state SHARED across users (the dedup Map is the
  existing example) is touched from interleaved async tasks — single-threaded
  atomicity between awaits is the only guard, so no await may sit between a
  shared-state read and its dependent write.
- The dedup Map's read-then-write is currently split by an await (the lazy DB
  load) but is per-user-key and chain-serialized — fine today; a worker-local
  presence cache will have the same shape and must keep the same discipline.
- Shutdown drain gives N5B a natural checkpoint hook: after allSettled, chains
  are empty and worker-local state is quiescent — the right moment to flush
  checkpoints before close (and the rebalance-handoff analogue).
