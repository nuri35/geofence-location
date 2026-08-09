# ADR 0014 — RabbitMQ topology with consistent-hash partitioning (Phase N4A)

- **Status**: Accepted
- **Date**: 2026-08-09

## Context

ADR 0011 fixes the queue design: a partitioned queue with a FIXED count of 256,
keyed `hash(userId)`, one worker owning several partitions, per-user order held
within a partition. This phase builds only the broker infrastructure — nothing
publishes, nothing consumes; the application is untouched. RabbitMQ's
`rabbitmq_consistent_hash_exchange` plugin (ships with the broker, off by
default) provides the hashing; the whole scheme depends on it, so it is enabled
declaratively via a mounted `enabled_plugins` file, not by hand.

## The topology

```
loc.events   (x-consistent-hash, durable)
  ├─ loc.events.p0 … p{N-1}   quorum queues, binding weight "1" each
  │                            policy loc-partitions:
  │                              delivery-limit: 5
  │                              dead-letter-exchange: loc.dlx
loc.dlx      (fanout, durable) ── loc.dead   (quorum)
```

- **Quorum queues**: the modern durable type, and the only one with a native
  redelivery counter (`delivery-limit`) — the DLQ path needs it.
- On a consistent-hash exchange the binding "routing key" is the **weight**;
  `"1"` everywhere gives each partition an equal share of the hash ring. The
  message routing key (the userId, from N4B on) is what gets hashed.
- The DLX is a fanout so a dead-lettered message reaches `loc.dead` regardless
  of the userId routing key it carries. `loc.dead` is deliberately outside the
  policy pattern — a DLQ must not dead-letter into itself.

## Where topology declaration lives, and why

**A one-shot compose job (`mq-topology`, curl against the management API),
running after the broker's healthcheck passes.** The options weighed:

- **Definitions file loaded at broker startup** — self-heals on every broker
  boot, but cannot read the environment: an env-driven partition count (8 dev /
  256 prod) would need a generation step anyway, i.e. a script — at which point
  the definitions file is just that script with an extra artifact. Definitions
  are also additive on load: a count change would silently leave orphan queues.
- **Application code declaring on connect** — the application does not exist in
  this phase, and worse, it makes every app instance a topology writer: two
  deployments racing with different partition counts is exactly the accident the
  count must be protected from. **N4B/N4C rule, decided now: the application
  NEVER declares this topology; it verifies (passive declare of the exchange at
  most) and fails loudly if the topology is absent.**
- **The one-shot job** — runs on every `compose up` (idempotent: management-API
  PUTs are no-ops for identical objects and hard 400s on drifted ones, which is
  the failure mode we want), ordered after broker health by compose itself, and
  env-parameterized. Its gap — a broker restarted alone does not re-run it — is
  closed by durability: the topology lives in quorum/durable objects on the
  `rabbitmq-data` volume, so a broker restart brings its topology back with it.
  Verified: `docker compose down && up` (volume kept) → declarator re-runs
  cleanly over the existing topology; `docker compose down -v && up` (virgin
  volume) → declarator recreates everything from nothing.

**Partition-count change is made hard to do accidentally.** The count is
effectively immutable once real traffic has flowed — changing it re-routes
existing users to different partitions and breaks per-user ordering, the one
property the scheme exists for. The declarator therefore refuses to run against
a broker whose existing `loc.events.p*` count differs from
`MQ_PARTITION_COUNT`, with the reason spelled out (verified: count 16 against 8
existing queues → exit 1, compose surfaces the failure). A deliberate
re-partitioning requires explicitly draining and deleting the old queues first —
an unmistakably manual act.

## Retry decision

**`delivery-limit: 5`, configured in the `loc-partitions` policy — not in queue
arguments.** Five redeliveries covers transient failures (a Postgres blip
resolves within the redelivery cycle) while bounding a poison message — the
FK-on-deleted-area hazard ADR 0012 recorded is exactly the shape that would
otherwise redeliver forever. After the fifth redelivery the message
dead-letters to `loc.dead` for operator inspection and replay. It lives in a
policy because queue arguments are frozen at declaration (changing them errors)
while a policy is mutable at runtime: the retry count stays tunable
(`MQ_DELIVERY_LIMIT`) without re-declaring or re-creating queues.

## The routing proof (broker tooling + throwaway script, no app code)

Placement — 12 user IDs, 5 messages each, published twice in separate runs:

- Every user's messages landed **wholly in one partition** (no splits), and the
  **second run reproduced the first exactly**:
  `user-8,user-11→p1; user-1,user-4→p2; user-3,user-5,user-10→p3; user-6→p5;
  user-0,user-2,user-7,user-9→p6`.

Distribution — 10,000 distinct user IDs, one message each, 8 partitions:

| partition | messages | share |
| --- | --- | --- |
| p0 | 1,301 | 13.0% |
| p1 | 1,233 | 12.3% |
| p2 | 1,189 | 11.9% |
| p3 | 1,237 | 12.4% |
| p4 | 1,277 | 12.8% |
| p5 | 1,274 | 12.7% |
| p6 | 1,235 | 12.3% |
| p7 | 1,254 | 12.5% |

min 1,189 / mean 1,250 / max 1,301, **max/min = 1.09** — consistent hashing
does not promise perfect balance and this is well within acceptable: the worst
partition carries 4% above fair share. At 256 partitions the per-partition
variance will be higher in relative terms (fewer users per bucket); the number
to re-check at N6 is max-partition share under real ID shapes, not this
synthetic one. (The 12-user run above also shows what small-N looks like: with
only 12 users, 3 of 8 partitions were empty — expected, irrelevant at real
population sizes.)

## What N4B (publisher) and N4C (worker) will find awkward — recorded now

- **Stats lag**: management-API queue counters lag ~5–7 s; nothing that needs
  accurate depth may read them synchronously. Publisher confirms via publisher
  confirms, not via queue stats.
- **The app must not declare** (rule above). ioredis-style "assert on connect"
  habits from client libraries would fight the guard; N4B should do passive
  verification and crash on absence.
- **One consumer per partition queue** is what per-user ordering actually
  requires at the consumer end; quorum queues support single-active-consumer
  (`x-single-active-consumer`) which was **deliberately not set** in N4A — it is
  a queue argument (frozen at declaration), so N4C must decide ownership
  strategy (SAC vs external assignment) BEFORE real traffic, ideally while
  re-declaring is still free. This is the one decision that may force a queue
  re-declare; make it early in N4C.
- **`receivedAt` travels in the message**, not the broker timestamp — decision 8
  semantics under backlog (ADR 0011) — so N4B must stamp before publish.
- Dev runs 8 partitions, prod 256: code must derive nothing from the count
  except the routing key (the exchange handles placement); anything that
  enumerates queues (the worker's ownership map) must read the actual broker
  state, not the env value.

## Verification trail

- From clean (`down -v && up`): three containers healthy, `mq-topology` exited
  0, plugin `rabbitmq_consistent_hash_exchange 3.13.7` listed as enabled
  (shown, not assumed), 9 `loc.*` queues with expected bindings and effective
  policy (dlx + delivery-limit visible per queue).
- Idempotency: re-`up` over live topology → exit 0; full `down`/`up` → exit 0,
  9 queues intact.
- Guard: `MQ_PARTITION_COUNT=16` against 8 existing → exit 1 with the
  immutability explanation.
- Green chain unchanged (build, lint, 88 unit, 73 e2e) — the application is
  untouched by this phase.
