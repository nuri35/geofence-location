# Scope boundaries — known gaps, their cost, and the right fix

Every non-goal in CLAUDE.md, expanded: what the gap is, what breaks because of
it, and what the fix would be with more time. This document exists so that
"didn't do it" reads as "chose not to do it and knows the cost". The choices
themselves are constitutional (CLAUDE.md); this file only carries the reasoning
and consequences.

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
target that a token bucket should also cover. The fix is a per-user bucket
(`@nestjs/throttler` — its distributed store would mean re-introducing Redis,
which was removed with the presence cache in ADR 0007 — or a gateway-level
limit). Deferred with the rest of the abuse surface, behind the missing
authentication.

## Observations from load testing — known and unaddressed

Not scope decisions but facts surfaced by the ADR 0007 measurement
(docs/PRESENCE_READ_MEASUREMENT.md) that a future phase must own:

- **Multi-second transaction stalls** (1.5–4.8 s max transaction age) recur in
  write-heavy load under every read strategy — strategy-independent, enough to
  destroy any run's p99. Checkpoint logs look healthy; WSL2/Docker WAL-fsync
  latency spikes are the prime suspect. Unaddressed because diagnosis needs
  config changes (`log_min_duration_statement`, possibly `statement_timeout`)
  that were out of bounds during measurement; both are Phase 4 items.
- **`/health` performs a real database ping per call** (it also pinged Redis
  until the cache removal), unauthenticated, plateauing at ~1k req/s on the
  reference box — an amplification target. Unaddressed because rate limiting as
  a whole is a non-goal (above); recorded so the token-bucket work covers it
  when it comes.

## Deferred optimisations — decided against for now, with revisit conditions

Two real optimisations, recorded as decisions rather than a to-do list (full
reasoning in the README's load section and ADR 0003):

- **One-round-trip request** (whole transition path in PL/pgSQL): unmeasured
  gain, moves the tested TypeScript transition model into SQL, and horizontal
  scaling buys more for less risk. Revisit when round trips measurably dominate
  *after* scaling out lifts the Node ceiling.
- **In-process polygon cache**: the right cache target if any (near-static,
  shared, read outside the lock — everything presence was not), but it removes a
  database round trip while Node is the wall, and multi-instance invalidation
  needs a broadcast component. Revisit via the stub experiment in ADR 0003's
  second annotation.

## Antimeridian and pole-crossing polygons

`geometry` with SRID 4326 does planar math in degrees: a polygon spanning the
±180° meridian is interpreted as wrapping the long way around the earth, and
containment is silently wrong — no error is raised (this is the same silent
failure class as invalid polygons, postgis-spatial skill §7). At city scale
this cannot occur. The fix, if area scope ever becomes global: reject rings
spanning more than 180° of longitude at validation, or split geometries at the
meridian (`ST_Split`) / model in `geography`. Out of scope as geometry
pathology the product cannot encounter.
