# ADR 0010 — Adaptive payload contract with per-device deduplication

- **Status**: Accepted
- **Date**: 2026-08-09

## Context

The target architecture (new-architecture plan): adaptive mobile clients → a
stateless validating API → a partitioned queue → workers holding polygons in
memory, writing to Postgres only on membership change. This phase lays the
payload groundwork while the system stays synchronous. Two ideas drive it: the
client is now *assumed adaptive* (sends only on ≥10 s elapsed AND ≥50 m moved
AND acceptable GPS accuracy — a fixed-timer client breaks the scaling
assumption the rest of the design rests on), and events are now *deduplicable*
(mobile retries are at-least-once by nature).

## The contract changes

`POST /locations` gains four fields:

- **`deviceId`** (≤64 chars) — one user may run several devices whose `seq`
  counters are independent; dedup state is keyed **(userId, deviceId)**, never
  user alone.
- **`seq`** (integer ≥0, monotonic per device) — **for deduplication only.**
  It is NOT an ordering guarantee: retries, multi-device users and network
  reordering all break monotonic arrival, and no logic may ever treat it as
  ordering. Stated here because it is the easiest field to misread later.
- **`capturedAt`** (ISO 8601) — when the device took the reading.
- **`accuracy`** (metres ≥0) — GPS error radius.

### `capturedAt` replaces `observedAt`

They mean the same thing; carrying both would be indefensible surface. The
column is renamed (`logs.observed_at` → `captured_at`, metadata-only
migration), the entity, `GET /logs` response field and Swagger follow.
**`observedAt` survives as a deprecated request alias** — accepted, mapped to
`capturedAt` when `capturedAt` is absent, marked deprecated in Swagger — so
pre-contract clients keep working. The one visible break is the `GET /logs`
response field name; accepted because the field feeds no logic and the
endpoint's consumers are ours.

### Existing clients — graceful, not breaking

`deviceId` and `seq` must arrive **together or not at all** (a seq without a
device identity is meaningless across devices; a device without a seq gives
nothing to dedup — one without the other is a 400). Absent both, the event is
processed exactly as before, without deduplication: legacy clients are
grandfathered into a degraded-but-correct mode rather than broken. `accuracy`
absent = trusted (legacy clients can't say better).

### The accuracy gate: 422, deliberately not 400

A reading with a >100 m error radius cannot answer "inside or outside" for a
boundary the user is standing anywhere near — processing it manufactures a
confident answer from unreliable input. Rejection is explicit (never a silent
drop) and uses **422 Unprocessable Content**: the request is well-formed (400
belongs to malformed shape, and stays with the validation pipe); its *content*
is unusable. The split is embodied in code: shape errors come from the DTO
layer as 400s, the semantic gate lives in the service as a 422.

## Deduplication mechanics

`user_event_state(user_id, device_id, last_seq, last_event_at)`, composite PK.
The check runs **inside the write transaction, under the advisory lock already
taken** — a dedup check that could commit separately from the work it guards is
not a dedup check. Non-newer seq → acknowledged as duplicate, nothing
processed, nothing updated. Newer seq → state upserted in the same transaction
as the transition work.

Two deliberate semantics:

- **Dedup runs on no-op requests too**, and the state row is written for every
  processed event — including the ~99% that change no membership. A duplicate
  no-op is therefore genuinely acknowledged, not silently reprocessed. Cost:
  every deduplicating ping now writes one small row (previously no-op pings
  were read-only transactions). Accepted for this synchronous phase; the queue
  phase moves this state out of the hot path (see Consequences).
- **A rejected duplicate is not an error.** The client did nothing wrong and
  the original processing stands. Response: **HTTP 200** (nothing was created)
  with `{ enteredAreaIds: [], duplicate: true }`; fresh events keep 201. The
  `duplicate` flag is always present so clients can branch without status-code
  sniffing.

## Consequences

- The adaptive-sending assumption is a **contract expectation recorded in the
  README**, defended server-side by the accuracy gate and dedup — the server
  cannot verify "moved ≥50 m" without state it deliberately doesn't keep.
- Per-ping write cost appears (state upsert) where no-op pings were WAL-free.
  At measured scale this is noise; at queue scale (Phase 4) dedup state is
  expected to move to per-partition worker memory, and this table becomes the
  durable checkpoint rather than the hot path.
- `capturedAt` remains informational-only (ADR 0005 unchanged): dedup uses
  `seq`, ordering remains server arrival order.
- The DTO now carries one deprecated field by design; removing the alias is a
  one-line change once no client sends it.
