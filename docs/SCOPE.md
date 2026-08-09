# Scope boundaries — known gaps, their cost, and the right fix

Every non-goal in CLAUDE.md expanded — what the gap is, what breaks because of
it, and what the fix would be with more time — plus two later additions of the
same species: observations from load testing that remain deliberately
unaddressed, and optimisations deliberately deferred with their revisit
conditions. This document exists so that "didn't do it" reads as "chose not to
do it and knows the cost". The choices themselves are constitutional
(CLAUDE.md); this file only carries the reasoning and consequences.

## Authentication and user identity trust

The API accepts `user_id` as claimed — nothing binds a request to a real
identity. Any client can submit locations as any user, polluting that user's
presence state and log history; in any adversarial setting the log is therefore
not evidence. The fix is standard and orthogonal to the geofencing problem:
authenticate (JWT or session), take the user ID from the verified token rather
than the request body, and add authorization on area management. Deferred
because the case assesses geofencing, not auth plumbing.

## Exit event logging

Only entries are logged; the presence-row delete (ADR 0002 step 4) is silent.
The cost is permanent: dwell time, occupancy, and "who left when" can never be
reconstructed from entry events alone — data not captured is gone. The fix is
nearly free if done at schema time — an `event_type` column (`entry` | `exit`)
and one more insert in the same transaction — which is exactly why this is
recorded now: if the product ever wants exits, add them *before* the data
matters, not after.

## GPS jitter hysteresis / debounce

The transition model is correct and its output can still be garbage: a user
parked near a boundary with ±10 m GPS noise oscillates across it, and every
crossing is a *genuine* entry — exit and re-entry really did occur. Consumers
of the log see spam. The fix is asymmetric boundaries: enter on
`ST_Covers(area, point)`, exit only when the point is more than N meters
outside (`ST_DWithin` with a `::geography` cast), or a time-based dwell rule.
Deferred because choosing N (or the dwell window) is a product decision, and an
invented value would be scope theater.

## Request idempotency keys

Mobile delivery is at-least-once; retries replay samples. The transition model
absorbs most of it — a repeated inside-sample causes no transition, and
identical concurrent requests are serialized by the advisory lock and collapsed
by `ON CONFLICT` (ADR 0002). The residual gap: a stale retry delivered *after*
the user exited re-enters them falsely, and nothing blocks that (see
"Out-of-order sample protection" below — same root cause, same fix). The full
fix is a client-generated idempotency key with a short-TTL server-side dedup
store. Deferred: the residue is small and the fix requires a client contract
this case doesn't have.

## Out-of-order sample protection

Processing order is server arrival order (ADR 0005), and `observed_at`
participates in no logic — so a location sample delayed in transit is processed
as if it were current. The cost: a stale sample can produce a wrong transition.
Concretely, a user exits area A, and an old inside-A sample arriving late
re-inserts their presence and logs a phantom entry; the next genuine report
corrects the state but the false log row remains. The real fix is client
sequence numbers — per-device monotonic counters that need no trusted clock —
rejected here because they change the client contract and a technical case has
no real client to hold to it. A client-clock staleness guard was considered and
dropped (ADR 0005, alternatives): it defended against this case badly, at the
price of per-user state and cross-clock comparisons. Related retention fact:
`observed_at` is persisted on entry log rows only (decision 8) — there is no
samples table and there will not be one, so a request that produces no entry
stores nothing and full location traces are simply not retained.

## Log retention and partitioning

The log table is append-only forever. At the assumed rate (~8 inserts/s) that
is ~700k rows/day, ~250M rows/year: `GET /logs` latency degrades and storage
grows unbounded. Irrelevant inside a 3-day case; mandatory before real traffic.
The fix is declarative time-based partitioning (or pg_partman), a retention
policy, and keyset-pagination indexes chosen to allow partition pruning.

## Area update/delete semantics for users already inside

Undefined, deliberately. Creating an area around a stationary user logs an
"entry" on their next report with zero movement — arguably right, arguably
noise. Editing a polygon can do the same, or silently release users. Deleting
an area leaves presence rows that then read as an exit on the next report — an
*accidental* behaviour, not a designed one — and requires at minimum a foreign
key with `ON DELETE CASCADE` so rows cannot dangle. The fix is a per-operation
decision matrix (does an administrative change generate user events or not?)
made with a product owner. Frozen rather than half-decided.

## Rate limiting

Nothing stops one client from reporting at 100 req/s instead of 0.1. The cost
is multiplied load share, pool pressure, and an open abuse surface — though not
log corruption, since extra inside-samples cause no transitions. Load
measurement added a data point: `/health` costs a real DB ping per call and
plateaus at ~1k req/s on the reference box — an unauthenticated amplification
target that a token bucket should also cover. The fix is a per-user bucket at
the stateless API (Redis is back in the stack since N3 and is its natural
home, or at the gateway). Still deferred with the rest of the abuse surface,
behind the missing authentication — and an honest correction of this file's
own earlier sentence: it said "N4 should not ship without at least a per-user
publish budget", and **N4 shipped without one**. The exposure is now real and
queue-shaped: an abusive client fills its hash partitions (delaying every user
sharing them) instead of merely burning CPU. Recorded as an open liability of
the async system, first in line behind authentication.

## Observations from load testing — known and unaddressed

Not scope decisions but facts surfaced by the ADR 0007 measurement
(docs/PRESENCE_READ_MEASUREMENT.md) that a future phase must own:

- **Multi-second transaction stalls** (1.5–4.8 s max transaction age) recur in
  write-heavy load under every read strategy — strategy-independent, enough to
  destroy any run's p99. Checkpoint logs look healthy; WSL2/Docker WAL-fsync
  latency spikes are the prime suspect. *Partially resolved since*: Phase 4B
  landed the bounds (ADR 0009 — the 5 s statement ceiling caps how long any
  stall can hold a connection), and the async pipeline moved these
  transactions off the request path entirely, so a stall now delays one
  partition's lane instead of a client. The DIAGNOSIS (why WSL fsync spikes)
  was never done and remains unowned — it will resurface in N6's numbers if
  the environment still has it.
- **`/health` performs a real database ping per call** (it also pinged Redis
  until the cache removal), unauthenticated, plateauing at ~1k req/s on the
  reference box — an amplification target. Unaddressed because rate limiting as
  a whole is a non-goal (above); recorded so the token-bucket work covers it
  when it comes.

## Assumptions depended on, not implemented

- **Client-side adaptive sending** (ADR 0010/0011): the scaling story assumes
  devices send on ≥10 s elapsed AND ≥50 m moved AND usable accuracy. That logic
  lives on the device and is *not implemented here* — the server records the
  assumption (README) and defends the edges it can see (accuracy gate, dedup).
  A fixed-timer client silently multiplies event volume without adding
  information; nothing server-side can fully compensate.
- **Centrally defined areas** — the in-memory polygon model's load-bearing
  assumption: areas come from `POST /areas`, an operations task, not a user
  action. That single fact is what makes the model possible — polygon count is
  independent of user count, so ten users and ten million users load the same
  few hundred shapes. If areas ever became user-drawn, polygon count would
  scale with users and the memory model collapses. The fix is not a bigger
  cache — it is a different partitioning dimension: geographic partitioning,
  each worker holding only the polygons for its region. That is a redesign, not
  a tuning change, because it conflicts with the `hash(userId)` partitioning
  the whole ordering guarantee rests on (decision 21): a user crossing a
  regional boundary would have to change partition, and that breaks per-user
  sequential processing at exactly the moment it matters most — a boundary
  crossing is precisely when an ENTER/EXIT decision is in flight.

## Deferred optimisations — decided against for now, with revisit conditions

Status after ADR 0011 (the target architecture) reshuffled this list:

- **In-process polygon cache** — *no longer deferred*: promoted to phase N2 as
  the in-memory versioned polygon snapshot, after the stub measurement fired
  its pre-registered revisit condition (ADR 0003, annotations 2–4).
- **One-round-trip request** (whole transition path in PL/pgSQL) — *dissolved
  rather than deferred*: the worker model of ADR 0011 removes the per-ping
  round trips wholesale, which is what this fold was for. No revisit condition
  remains; git history keeps the analysis.
- **Worker-local presence state** — *resolved by decision, then built* (N5B,
  ADR 0018). The original rejection rested on rebalance split-brain; static
  partition ownership (ADR 0016) removed that mechanism without waiting for
  rebalance fencing — exclusive ownership is a decision about the deployment
  layer, not an omission. The residue moved, not vanished: when N5-final makes
  ownership dynamic, partition movement MUST invalidate the moving users'
  memory, and that obligation is recorded in ADR 0018.
- **Business-event publication** (ENTER/EXIT as consumable events for other
  systems): deferred until a second consumer exists — publishing to nobody is
  surface without a customer.
- **Geohash-based fast paths** (pre-filtering candidate areas by cell):
  deferred until the in-memory polygon set is measurably too large for brute
  R-tree/linear checks — at current area counts it is noise.
- **Prepared polygon snapshot**: today each instance queries Postgres at
  startup and builds its own spatial index — at a few hundred areas that costs
  a few hundred KB and a couple hundred milliseconds, and per-instance
  duplication is irrelevant since each process has its own memory. Around tens
  of thousands of polygons, startup parsing becomes seconds and the footprint
  becomes worth counting — mattering most during deployment and partition
  rebalance, when many workers start at once. The fix, deliberately not built:
  a prepared, versioned snapshot artifact that workers load rather than each
  parsing source data independently. The constraint is startup cost and parse
  work, not query speed — the R-tree stays logarithmic and is not the problem
  at any of these sizes.
- **Kafka migration**: the initial broker choice serves 256 partitions fine;
  reopens if partition count, retention, or consumer-group semantics outgrow
  it. A broker swap behind the worker interface is the designed-for case.

## Antimeridian and pole-crossing polygons

`geometry` with SRID 4326 does planar math in degrees: a polygon spanning the
±180° meridian is interpreted as wrapping the long way around the earth, and
containment is silently wrong — no error is raised (this is the same silent
failure class as invalid polygons, postgis-spatial skill §7). At city scale
this cannot occur. The fix, if area scope ever becomes global: reject rings
spanning more than 180° of longitude at validation, or split geometries at the
meridian (`ST_Split`) / model in `geography`. Out of scope as geometry
pathology the product cannot encounter.
