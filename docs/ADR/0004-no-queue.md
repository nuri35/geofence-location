# ADR 0004 — No message queue on the write path

- **Status**: Accepted
- **Date**: 2026-08-07

## Context

"High concurrent load" invites putting a queue between ingestion and
persistence. Whether one is warranted is arithmetic, not taste — so the
arithmetic is shown here, checkable, rather than asserted.

## Decision

No queue. The numbers:

- **Load**: 10,000 active users × one report every 10 s = **~1,000 req/s**
  sustained.
- **Average entry rate**: at roughly 3 area entries per user per hour, 3 of the
  360 requests each user makes per hour carry a transition → 1/120 of requests
  → **~8 persistent log inserts/s**.
- **Peak, stated separately**: 10,000 users crossing a single geofence within
  one minute ≈ **~170 inserts/s** for that minute.

Both rates are trivial for PostgreSQL on any hardware this project will meet;
connection pool sizing absorbs the peak. A broker (BullMQ, RabbitMQ) would add
an infrastructure dependency, an at-least-once redelivery duplicate class, and
operational surface — to protect a resource with three orders of magnitude of
headroom.

Precision the original framing lacked: **persistent log writes are rare —
writes in general are not.** The cache is written on every transition and read
on every request; presence maintenance runs per request. The rarity claim is
scoped to durable log inserts only.

## Alternatives considered

- **BullMQ / RabbitMQ between ingestion and persistence** — rejected as
  premature optimization: the protected resource is idle, and the broker
  introduces its own failure modes, duplicate-delivery semantics, and
  compose/green-chain surface.
- **Postgres-native queueing (`LISTEN/NOTIFY`, table-as-queue)** — rejected:
  there is no consumer. Nothing downstream of the log insert is slow, so there
  is nothing to decouple.

## Consequences

Positive: one fewer container, one fewer failure domain, exactly-once log
semantics stay a database property (ADR 0002) instead of becoming a
deduplication problem.

Negative / accepted honestly: if the write path ever gains a slow side effect,
inline execution would couple request latency to it.

## Revisit condition

The day the write path gains a slow side effect — notifications, webhooks, a
third-party call per entry — this decision reopens, because the requirement
becomes latency decoupling, not throughput. Record the change as a new
appended decision in CLAUDE.md and a new ADR; do not edit this one.
