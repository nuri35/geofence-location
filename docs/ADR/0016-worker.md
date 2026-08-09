# ADR 0016 — The worker: static partition ownership, lazy dedup, ack-after-commit (Phase N4C)

- **Status**: Accepted
- **Date**: 2026-08-09

## Context

N4B left events accumulating with nothing consuming them. This phase closes the
loop: a separate worker process consumes its assigned partitions and runs the
transition path N4B parked. Testing beyond proving the loop works is N4D;
rebalancing, failover, and per-user parallelism are N5.

## Consumer strategy: external assignment, not single-active-consumer

Each worker learns its partitions from configuration (`WORKER_PARTITIONS=0-3`;
ranges and lists accepted; dev default `0-7` so one worker covers the 8 dev
partitions). SAC would hand ownership to the broker; this architecture needs
ownership known and stable in the process because N5 builds rebalancing on it.
`single-active-consumer` remains UNSET on the queues (N4A left it free
deliberately — it is a frozen queue argument). Failover is therefore ours to
write, and it is N5's work: in N4C a lost broker connection is fatal by design
(`process.exit(1)`; the supervisor restarts).

## Nest's RMQ transport: verified, fights all three points, not used

Read from `@nestjs/microservices@11.1.28` source (`server/server-rmq.js`), not
assumed:

1. **It declares.** `assertQueue` runs on setup unless `noAssert` is opted into
   (lines 121–126) — the default violates the ADR 0014 rule invisibly.
2. **Its nacks bypass our retry path.** On a missing handler or deserialization
   failure it calls `channel.nack(msg, false, false)` itself (lines 178, 197) —
   requeue FALSE, straight past the delivery-limit policy to the DLQ, on code
   paths we don't control.
3. **One queue per server instance.** `ServerRMQ` consumes a single `this.queue`;
   this worker owns several partitions per process.

Conclusion: `amqplib` directly (the publisher already established the pattern).
The worker's channel does **passive `checkQueue`** on every owned partition at
bootstrap and aborts boot if any is missing — verify-and-fail, never declare.

## Dedup: lazy, in memory, no writes

`userId:deviceId → highest seq processed`, loaded from `user_event_state` on
first sight of a device (a user with no row starts at 0), then served from
memory. **The Map is bumped only after successful processing** — a nacked
message must be retried, not treated as its own duplicate. N1's per-event write
to `user_event_state` is gone from the event path: the worker deliberately does
NOT forward `deviceId`/`seq` into `report()`, so the table is read-only here.
(The in-transaction dedup code inside `report()` survives untouched for the
parked service-level path until N4D retires it; N5 restores table writes as
rebalance checkpoints.)

**Stated plainly: a worker crash loses the in-memory dedup state.** Redelivered
or replayed duplicates after a crash are absorbed by `ON CONFLICT` in the
transaction — correctness never rests on this Map; it only saves work.

**Footprint, measured** (V8 heap, realistic ~37-char keys): ~293 bytes/entry —
100k user-devices ≈ 28 MB, 1M ≈ 280 MB. Each worker holds only its partitions'
share of the population (≈ 1/workers). Unbounded for now by decision; an LRU
becomes worth building around a few hundred thousand entries per worker — N5's
call, with this number as its input.

## Per message

Parse + schema check (`v: 1`) → dedup gate → `LocationsService.report()` — the
parked path unchanged, mounted here — with **`recordedAt = the message's
receivedAt`**, never `now()`: under backlog the log records when the system
accepted the event (decision 8). `report()` gained exactly one thing for this:
an optional `recordedAt` parameter defaulting to `now()` (the service-level and
historical behavior are untouched). Accuracy travels and is re-gated by
`report()`'s existing check. Prefetch is **1 per consumer (temporary by
decision)**: serial within a partition preserves per-user ordering; parallel
across partitions. Raising it requires N5's per-user parallelism.

## ACK discipline

- Ack **after commit**: `report()` resolves post-COMMIT (ADR 0002), so a worker
  dying mid-transition rolls back and redelivery starts from a clean state.
- The no-change fast path (ADR 0013) opens no transaction and acks directly.
- **One narrow exception**: a foreign-key violation whose constraint references
  the area (`23503` + constraint name contains `area` — `fk_presence_area` and
  the logs equivalent) means the area was deleted inside the snapshot staleness
  window ADR 0012 recorded. Retrying cannot help: ack, warn-log with the
  eventId, increment `staleAreaDropCount`. The classifier is deliberately this
  tight — anything broader would swallow real failures into acks.
- Everything else — including malformed payloads and unknown schema versions —
  takes the normal `nack(requeue=true)` path; the delivery-limit policy (5)
  bounds redeliveries and dead-letters to `loc.dead`.

## Waiting strategy for async assertions (N4D leans on this)

`waitFor(label, condition, timeoutMs)` in the worker-loop spec: polls every
100 ms, throws with the caller's label on timeout — a hang names the stage that
hung. Poll-with-timeout, never fixed sleeps.

## Packaging note

The worker is a separate entrypoint (`node dist/worker-main`, `npm run
start:worker`) and process, independently scalable. It is NOT a compose service
because nothing in this repo is — the API itself runs uncontainerized on the
host; adding a Dockerfile for the worker alone would invent packaging the
project doesn't have. Containerizing both is one deployment task, out of this
phase.

## Also in this phase

- The polygon snapshot + version polling now runs in the worker (per-event
  evaluation lives there). The API keeps its own snapshot instance for the
  parked service path and `POST /areas`' local refresh until N4D.
- e2e hardening: `locations-publish.e2e-spec` fails fast with a named error if
  any consumer is attached to the partitions (a running worker would eat the
  messages it asserts on — observed once as interference from a concurrently
  launched test run on this machine).

## What N5 must change (ownership is now real, if static)

- **Rebalancing/failover**: fatal-on-disconnect becomes handoff; the dedup Map
  needs checkpointing to `user_event_state` (writes return as checkpoints) and
  invalidation on partition release/acquire — the split-brain ADR 0011 warned
  about lives exactly here.
- **Prefetch > 1** requires per-user serialization inside a partition (the
  advisory lock guards correctness but not ordering under concurrent same-user
  processing).
- **LRU for the dedup Map** if per-worker population crosses the measured line.
- The `WORKER_PARTITIONS` parser and the passive checkQueue-per-partition loop
  are the natural seam for dynamic assignment — ownership changes become
  consume/cancel calls on the same channel.

## Verification trail

Full chain green twice consecutively (build, lint, 108 unit, 79 e2e / 14
suites). Live loop through the real artifacts (`node dist/main` +
`node dist/worker-main`, separate processes): `POST /locations` →
`202 {"eventId":"7b782362-…"}` with envelope timestamp `11:46:05.159Z`; log row
appeared with `recorded_at = 11:46:05.153+00` — the API's receivedAt stamp,
milliseconds BEFORE the response, provably not worker-processing time; all 8
partitions showed `msgs=0, consumers=1` after consumption.
