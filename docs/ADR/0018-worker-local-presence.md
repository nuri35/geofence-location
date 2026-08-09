# ADR 0018 — Worker-local presence state (Phase N5B)

- **Status**: Accepted
- **Date**: 2026-08-09

## Context

The last piece of ADR 0011's target. Presence was read from Redis (or Postgres)
on every message, keeping Redis a synchronous dependency of every location
event. With static partition ownership (ADR 0016) the same user always lands on
the same worker — so the worker remembers, and the presence read becomes a Map
lookup with no network call.

## Decision

`PresenceMemoryService` — a synchronous Map, provided ONLY by `WorkerModule`
(the API is multi-instance; memory there would be split-brain, exactly what
ADR 0011 rejected). `LocationsService` takes it `@Optional()`: present, the
worker path; absent, the ADR 0013 path unchanged (the parked service-level
flow).

**Read order in the worker: memory → Postgres.** The brief's middle layer
(Redis) collapsed as a consequence of the cold-read decision below — with
static ownership no OTHER worker ever reads this user's key, so Redis-on-read
purchased nothing except the poisoning path.

**On a committed transition: memory is updated directly; the Redis key is
DELETED, never SET.** Memory update is safe because writer and reader are one
process (a synchronous `set` immediately after commit — no await between, per
ADR 0017's rule). Redis gets DEL not SET because its remaining readers are
other processes (the parked API path today, a rebalanced worker tomorrow), and
two concurrent SETs can land out of order leaving the older value resident — a
DEL cannot. A dedup-duplicate writes nothing and leaves memory untouched.

## The cold-memory-after-restart decision

The stated residual of the memory design: if a post-commit DEL fails AND the
worker restarts within the key's TTL, a Redis-seeded cold read would copy the
stale value into a Map that has NO TTL — converting ADR 0013's time-bounded
suppression into an unbounded one. **Chosen: cold reads go to Postgres,
never Redis.** Three reasons:

1. Memory is then seeded exclusively from the source of truth — the poisoning
   path does not exist, rather than being unlikely.
2. The feared "recovery storm" is not a storm: reads are lazy, paced by each
   user's own event arrival, one PK-indexed SELECT per active user per restart
   (measured at 0.013 ms in Phase 2). No synchronized bulk load exists.
3. With static ownership Redis had no other worker-side reader anyway; keeping
   it in the read path bought one cheap read in exchange for the failure
   analysis above.

## What this dissolves, and what remains

The ADR 0013 stale-cache hazard is **structurally gone from the hot path**: the
fast path never reads Redis when memory answers, and memory cannot be stale to
its own writer. What remains, stated rather than hidden:

- The parked API-side path (service-level e2e, until deleted) still runs the
  ADR 0013 shape with its TTL-bounded exposure — unchanged, still documented.
- Worker memory trusts that partition ownership is exclusive. Under N5-final's
  rebalancing, a partition moving between workers MUST invalidate/hand off the
  affected users' memory — otherwise two workers hold divergent pictures (the
  ADR 0011 split-brain). Static assignment makes this a non-issue today; the
  handoff hook exists (the shutdown drain point, ADR 0017).
- The advisory lock + authoritative re-read under it remain the write-path
  guard — memory, like every hint before it, NEVER feeds a write (the hard
  constraint holds; writes recompute under the lock).

## The ADR 0017 invariant, located

"No await between a shared-state read and its dependent write" lives in three
places: (1) `PresenceMemoryService` is synchronous-only by shape — no method
can await; (2) its class doc states the caller contract (same-user calls must
be serialized — in this codebase, the worker's per-user chain in
`WorkerConsumerService.enqueue`); (3) the post-commit `set` in
`LocationsService` sits immediately after the transaction resolves with no
intervening await. The API process cannot violate it because the service is
not provided there.

## Memory, measured

~**287 bytes/entry** at a realistic 70% outside (`[]`) / 30% inside (one uuid)
mix — 100k users on a worker ≈ 29 MB, 1M ≈ 274 MB; each worker holds only its
partitions' slice. Together with the dedup Map (~293 B/entry, ADR 0016), plan
~0.6 KB per active user-device per worker. No LRU built: the number does not
demand it below a few hundred thousand users per worker (same threshold ADR
0016 recorded for dedup — N5-final revisits both together if ever needed).

## Proven

- Unit: warm memory + no change touches nothing (no Redis, no Postgres, no
  transaction); cold memory seeds from Postgres and never calls Redis; a
  committed transition sets memory to the post-commit set and still DELs; a
  duplicate leaves memory untouched.
- e2e (desync, not spying): a planted wrong Redis value stays unconsulted,
  unDELed, and produces no wasted transaction on a memory-warm ping; after a
  transition memory holds the new value immediately and the pre-planted key is
  gone; with Redis pointed at a dead port, warm users process normally (the
  failed DEL is counted `gets_failing`) and cold users seed correctly from
  Postgres.
- The spec briefly failed order-dependently — overlapping test fixtures (an
  entry produced two logs and a `waitFor(=== 1)` sailed past 2), a real
  geometry bug in the test, fixed by disjoint areas and recorded in the spec.

## What the architecture still owes (input to N5-final)

- **Rebalancing itself**: ownership is static; handoff, fencing, and memory/
  dedup invalidation on partition movement are designed (hooks exist) but not
  built or proven.
- **Checkpointing**: `user_event_state` writes as rebalance checkpoints
  (ADR 0016's promise) — not built; a crash still re-reads presence lazily and
  re-drops duplicates via ON CONFLICT, which is correct but unmeasured at scale.
- **The end-to-end numbers**: no load measurement has run since N3 — the queue
  path's throughput, the fast path's share, redelivery behavior under load,
  and the dedup/presence memory growth curves are all unproven claims until
  N6's harness runs against the full async pipeline.
- **DLQ operations**: messages CAN reach loc.dead (delivery-limit 5) but no
  replay tooling or alerting exists.
- **Deployment packaging**: neither API nor worker is containerized; the
  "independently scalable" claim is structural, not operationally exercised.
