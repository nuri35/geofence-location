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

## 9. persists observed_at without letting it affect the outcome

- **Setup**: area A. U outside A.
- **Sequence**: `POST /locations` for U inside A carrying an `observed_at` far
  in the past; later, the same sequence for a second user V without any
  `observed_at`.
- **Expected**: identical transition outcomes for U and V — one entry log each,
  one presence row each (ADR 0005: `observed_at` participates in no logic).
  U's log row carries the supplied `observed_at` verbatim; V's carries null.
  Both rows' `recorded_at` are server-assigned.

## 10. preserves all transition semantics with Redis unavailable

- **Setup**: stop the Redis container (`docker compose stop redis`).
- **Sequence**: re-run the sequences of scenarios 2, 3, 4, and 8.
- **Expected**: identical log and presence outcomes; no request fails with a
  5xx. Only latency may differ — decision 6: losing Redis costs latency, never
  correctness.

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
