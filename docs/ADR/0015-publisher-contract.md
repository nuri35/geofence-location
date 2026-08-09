# ADR 0015 — The API becomes a publisher: 202 contract and the location event schema (Phase N4B)

- **Status**: Accepted
- **Date**: 2026-08-09

## Context

ADR 0011's stateless API: validate, stamp `receivedAt`, publish to the
partitioned queue (ADR 0014), return 202. This phase makes `POST /locations`
exactly that — it computes nothing. DTO validation, the ADR 0010 accuracy gate,
and `receivedAt` capture stay at the edge; everything else leaves the request.

## The contract

`POST /locations` → **202 Accepted, `{ eventId }`** in the standard envelope. No
`enteredAreaIds`, no `duplicate` — nothing has computed them at response time.
Decision 11's 201 contract, which its own text scheduled for retirement "at N4",
is retired. **Eventual consistency is now a documented API property**: after a
successful 202, `GET /logs` may not show a resulting entry until a worker (N4C)
consumes the event — stated in the Swagger operation and the README so a client
developer reads it before filing the bug.

**Between N4B and N4C the deployable artifact accepts events and processes
none** — published events accumulate durably in the partitions. This is a known,
deliberate interim: the repository stays green because the transition logic
remains fully covered (below), but N4B and N4C must reach production together.

## The message — v1, and what N4C cannot change later

```json
{
  "v": 1,
  "eventId":   "uuid, server-assigned; also the AMQP messageId",
  "userId":    "string — also the routing key, RAW",
  "deviceId":  "string | null",
  "seq":       "number | null",
  "lat": 0.0, "lng": 0.0,
  "accuracy":  "number | null — travels although nothing persists it (worker may re-gate)",
  "capturedAt": "ISO | null — observedAt alias resolved BEFORE the wire",
  "receivedAt": "ISO — stamped by the API at acceptance"
}
```

AMQP properties: `persistent`, `mandatory`, `contentType: application/json`,
`messageId = eventId`, `type: location.v1`, broker `timestamp`.

- **`receivedAt` is the load-bearing field**: under backlog a worker processes
  minutes late, and the log's `recorded_at` must be when the SYSTEM accepted the
  event (decision 8), not when a worker got to it.
- **`v` + the `location.v1` type property** exist so the schema can evolve
  without a compatibility crisis — the worker dispatches on them from day one.
- **Routing key = the RAW userId.** The consistent-hash exchange hashes the key
  itself; pre-hashing in the app would hash twice — same-user-same-partition
  would still hold, but placement would silently diverge from N4A's recorded
  proof. Verified live: `user-3` published through the prod artifact landed in
  `loc.events.p3`, exactly where the N4A proof put it.
- Absent optionals travel as explicit `null`, never as missing keys — the worker
  never guesses whether a field was omitted or dropped.

## Publish failure → 503, never a silent 202

Publishes resolve only on the **publisher confirm** (queue-depth stats lag 5–7 s,
measured in N4A, and are never a signal). If the confirm does not arrive —
broker down, channel gone, nack, 5 s timeout — the request fails with **503 +
`Retry-After`**, the exact transient contract ADR 0009 established, via a marker
(`transientPublishFailure`) the exception filter maps. Why not return 202 and
drop: the entry log is the product; acknowledging an event that was never
durably queued converts a transient broker blip into permanent, silent data
loss. Why 503 is cheap: the adaptive client re-sends its position on the next
ping anyway — the cost of honesty is one retry that was already scheduled.
Rejected alternative: buffering unpublished events in process memory —
unbounded under a real outage, lost on crash, and it reorders a user's lane.

The client keeps a fail-fast connection: reconnect with capped backoff in the
background, publishes failing fast (503) while disconnected. At bootstrap the
app **passively verifies** `loc.events` exists and aborts boot if not — the N4A
rule (the app never declares topology) enforced in code; a "helpful"
assert-on-connect could race a deployment with a different partition count.
`mandatory` publishes surface topology damage: an unroutable return is logged at
error level as the only trace (the confirm still acks returned messages).

## The transition logic is parked, not orphaned

`LocationsService.report()` — the full ADR 0002/0013 transition path — is
untouched and off the HTTP path. It is exactly the code N4C mounts in the
worker. It stays alive three ways: its unit suite (unchanged), the acceptance
scenarios in `test/locations.e2e-spec.ts` now driving it **at service level**
against the real database/cache/lock, and the N3 specs (presence-cache,
stale-presence, redis-down, area-snapshot) adapted the same way. Nothing was
deleted; no assertion was quietly dropped — the changes are:

- Acceptance scenarios 1–9, 13, dedup, cascade, rollback: HTTP helper → service
  call; identical assertions on logs/presence/results.
- The rollback test's HTTP-500-shape half moved with the path off HTTP; the
  generic internal-error contract remains pinned by `errors.e2e-spec`.
- `bounds`: the advisory-lock ceiling is asserted at service level (57014 after
  ~5 s — the same bound that will limit a stuck worker partition); the HTTP
  503 + `Retry-After` shape re-points at `GET /logs` under pool exhaustion,
  because POST /locations no longer touches the pool at all — by design.
- HTTP-layer tests (validation 400s, accuracy 422, deviceId/seq pairing) stay at
  HTTP, where those contracts still live; the new `locations-publish.e2e-spec`
  owns the 202/publish contract and asserts real broker placement.

N4D re-points the acceptance scenarios at the full async path.

## What N4C may wish were different — considered now

- The event does **not** carry a polygon-snapshot version: the worker evaluates
  against ITS current snapshot, not the one live at acceptance time. Under
  backlog plus an area change, an event can be evaluated against newer polygons
  than the client saw. Deliberate: decision 8 already makes receipt time
  authoritative and area-change semantics for in-flight users are a declared
  non-goal; pinning versions would require keeping historical snapshots forever.
- `lat`/`lng` stay as in the DTO (no GeoJSON point) — the worker feeds them to
  the in-memory index directly; a formal Point would be ceremony.
- Dedup still travels as `(deviceId, seq)` pass-through; the worker owns all
  dedup semantics (decision 27's contract carries forward).

## Verification trail

Green chain: build, lint, 101 unit (publisher, ingest, filter marker added),
77 e2e across 13 suites. Prod artifact: boot log shows
`amqp connected; exchange 'loc.events' verified (passive)`; real request →
`202 {"eventId":"c6f8f00d-…"}`; management-API peek shows that exact messageId
in `loc.events.p3` with `delivery_mode=2`, `type=location.v1`, and the full v1
payload including `receivedAt` — the partition N4A's routing proof predicted
for `user-3`.
