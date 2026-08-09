# Acceptance scenarios

Written in Phase 0, before any implementation. Each scenario is phrased so its
title can become a test name directly. Each gives: setup, the sequence of
requests, and the expected observable result. "Log row" means a row in the
entry log with (user, area, `recorded_at`); presence means `user_area_presence`
(ADR 0002).

Response contracts are decided: `POST /locations` returns 201 with
`{ enteredAreaIds: [...] }` inside the standard response envelope (decision 11),
and validation failures are 400 (CLAUDE.md hard constraints). Scenarios assert
observable state throughout; scenario 13 asserts the response body itself.

> **N4B note (ADR 0015):** `POST /locations` publishes instead of processing, so
> the transition scenarios below execute **at service level** — the same
> `LocationsService.report()` the N4C worker mounts — against the real database,
> cache and advisory lock. HTTP-layer scenarios (validation, the accuracy gate)
> remain at HTTP; the 202 publish contract is pinned by
> `test/locations-publish.e2e-spec.ts`. The full async path (publish → worker →
> logs) is covered by the `worker-loop`, `worker-resilience`,
> `worker-parallelism`, and `worker-presence-memory` e2e specs for the loop,
> exactly-once-under-kill, ordering, backlog timestamps, and presence-memory
> properties; re-pointing the numbered scenarios themselves at that path
> remains open (deferred from N4D-short, owed alongside N6).

## Scenario → test map

| # | Proven by |
| --- | --- |
| 1–8 | `test/locations.e2e-spec.ts` — test names carry the scenario number verbatim (e.g. "4. logs a second entry after exit and re-entry"; 8 is the 20-way concurrent race) |
| 9 | `test/locations.e2e-spec.ts` — "9. persists capturedAt verbatim without letting it affect the outcome" (includes the deprecated observedAt alias) |
| 10 | **Un-retired at Phase N3** — `test/redis-down.e2e-spec.ts` boots the app against a dead Redis port and proves entry/dwell/exit-reenter/overlap/concurrency semantics unchanged; additionally verified with the container genuinely stopped (`docker stop geofence-redis`, 65 tests green, N3 trail) |
| 11 | `test/areas.e2e-spec.ts` — "11. rejects a self-intersecting bowtie…" + "11. rejects an unclosed ring…" (test titles carry the scenario number) |
| 12 | `test/locations.e2e-spec.ts` — "12. rejects out-of-range coordinates and oversized userId with 400"; `test/areas.e2e-spec.ts` — "12. rejects out-of-range coordinates with 400" |
| 13 | `test/locations.e2e-spec.ts` — "13. returns 201 naming exactly the areas entered, then an empty array" |
| 14 | `test/areas.e2e-spec.ts` — "14. rejects 1001 distinct vertices and accepts 1000" |

Beyond the scenarios, `test/locations.e2e-spec.ts` also proves the cascade
(area delete removes presence and log rows) and transactionality (a forced
mid-transaction failure rolls back the presence write).

## 1. logs nothing for a user outside all areas

- **Setup**: one area A. User U has no prior state.
- **Sequence**: `POST /locations` for U with a point not covered by A.
- **Expected**: request accepted; no log row for U; U has no presence rows.

## 2. logs exactly one entry when a user crosses into an area

- **Setup**: area A. U's previous report was outside A (scenario 1 state).
- **Sequence**: `POST /locations` for U with a point covered by A.
- **Expected**: exactly one log row (U, A) with a server-assigned
  `recorded_at`; presence contains exactly (U, A).

## 3. logs nothing further while a user remains inside

- **Setup**: U inside A, entry already logged (scenario 2 state).
- **Sequence**: ten `POST /locations` for U, all covered by A.
- **Expected**: log count for (U, A) is still exactly 1; presence unchanged.

## 4. logs a second entry after exit and re-entry

- **Setup**: U inside A, entry logged.
- **Sequence**: `POST /locations` outside A, then `POST /locations` inside A.
- **Expected**: after the outside report, no new log and presence for (U, A) is
  gone; after the second inside report, a second (U, A) log row exists — total
  exactly 2.

## 5. logs one entry per area for overlapping areas

- **Setup**: areas A and B overlap. U has no presence.
- **Sequence**: one `POST /locations` for U with a point covered by both.
- **Expected**: exactly two log rows from this single request — one (U, A), one
  (U, B); presence contains both pairs.

## 6. logs only the new area when entering a second area while inside the first

- **Setup**: U inside A only (one (U, A) log).
- **Sequence**: `POST /locations` with a point covered by both A and B.
- **Expected**: exactly one new log row (U, B); (U, A) log count unchanged;
  presence contains both pairs.

## 7. records an entry on the first-ever report from inside an area

- **Setup**: area A. U has never reported before.
- **Sequence**: U's first `POST /locations`, point covered by A.
- **Expected**: exactly one log row (U, A) — decision 9: recorded as an entry
  even though no transition was observed.

## 8. writes exactly one log for two identical concurrent requests

- **Setup**: area A. U outside A (or never seen).
- **Sequence**: two identical `POST /locations` for U, dispatched concurrently.
- **Expected**: both requests complete without error; exactly one log row
  (U, A); exactly one presence row (U, A).

## 9. persists capturedAt without letting it affect the outcome

*(Field renamed from `observedAt` by ADR 0010 — same semantic; the deprecated
`observedAt` request alias must persist identically.)*

- **Setup**: area A. U outside A.
- **Sequence**: `POST /locations` for U inside A carrying a `capturedAt` far
  in the past; later, the same sequence for a second user V without any
  `capturedAt`.
- **Expected**: identical transition outcomes for U and V — one entry log each,
  one presence row each (ADR 0005: `capturedAt` participates in no logic).
  U's log row carries the supplied `capturedAt` verbatim; V's carries null.
  Both rows' `recorded_at` are server-assigned.

## 10. preserves all transition semantics with Redis unavailable

*(Retired 2026-08-07 when the first cache was removed with ADR 0007; un-retired
2026-08-09 when Redis returned as the presence cache behind the no-change fast
path, ADR 0013.)*

- **Setup**: areas A and B (overlapping); Redis unreachable (dead port or
  stopped container). The app must boot.
- **Sequence**: the core transition flows — cross in, dwell, exit and re-enter,
  overlap entry, 20 identical concurrent requests.
- **Expected**: identical outcomes to Redis-up operation — every cache read
  errors and falls through to the unlocked Postgres read; nothing is written
  back on errors; the change path is untouched. Correctness never depends on
  any store but PostgreSQL (ADR 0002); losing Redis costs latency only.
  Proven by `test/redis-down.e2e-spec.ts` and a full-suite run with the
  container stopped.

## 11. rejects an invalid polygon with 400 and stores nothing

- **Setup**: none.
- **Sequence**: `POST /areas` with a self-intersecting ring (bowtie:
  `(0 0, 10 10, 10 0, 0 10, 0 0)`); then `POST /areas` with an unclosed ring
  (last coordinate ≠ first).
- **Expected**: both rejected with 400; the self-intersection response carries
  the `ST_IsValidReason` output; no area row is stored in either case;
  `GET /areas` does not list them.

## 12. rejects out-of-range coordinates with 400

- **Setup**: none.
- **Sequence**: `POST /locations` with latitude 91; `POST /locations` with
  longitude 181; `POST /areas` containing a vertex with latitude −91.
- **Expected**: all rejected with 400 at the DTO layer (lat ∈ [−90, 90],
  lng ∈ [−180, 180]); no state of any kind is touched.

## 13. returns 201 naming exactly the areas entered

- **Setup**: areas A and B overlap. U has no prior state.
- **Sequence**: `POST /locations` for U with a point covered by both; then an
  identical second request.
- **Expected**: first response is 201 with `data.enteredAreaIds` containing
  exactly A's and B's ids (decision 11; `data` is the response envelope). The
  second response is 201 with `data.enteredAreaIds` = `[]` — accepted, nothing
  entered. The body must agree with the database: ids in `enteredAreaIds`
  correspond one-to-one with the log rows the request created.

## 14. rejects a polygon over the vertex cap

- **Setup**: none.
- **Sequence**: `POST /areas` with a valid, closed ring of 1001 distinct
  vertices.
- **Expected**: 400 at the DTO layer (cap: 1000 vertices, CLAUDE.md hard
  constraints); no area row stored; a ring of exactly 1000 vertices is
  accepted.
