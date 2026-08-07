# ADR 0006 — Read endpoint pagination: keyset for logs, offset for areas

- **Status**: Accepted
- **Date**: 2026-08-07

## Context

`GET /logs` reads an append-only table that grows forever and receives
concurrent inserts while being paged. `GET /areas` reads a small, nearly
static table. One pagination style does not fit both.

## Decision

- **`GET /logs`: keyset pagination** with a cursor over `(recorded_at, id)`,
  plus filters `userId`, `areaId`, `from`, `to`. Offset pagination is
  explicitly rejected: under concurrent inserts on an append-only table it
  skips and duplicates rows as pages shift, and its cost grows linearly with
  the offset. The cursor dictates the indexes: a composite btree on
  `(recorded_at, id)` for the unfiltered walk, and `(user_id, recorded_at, id)`
  / `(area_id, recorded_at, id)` for the filtered ones — the final set is
  confirmed with `EXPLAIN ANALYZE` in Phase 4, where these indexes land.
- **`GET /areas`: plain `limit`/`offset`**, returning full geometry as GeoJSON.
  Offset is acceptable here for the same reasons it is wrong for logs, in
  reverse: the row count is small and the table is nearly static, so shifted
  pages and offset cost cannot occur in practice. The two endpoints differ *by
  decision*, not by accident — this ADR is the record of that.

## Alternatives considered

- **Offset pagination on `/logs`** — rejected, as above: incorrect under
  concurrent writes and degrades with depth.
- **Keyset on `/areas` too, for uniformity** — rejected: it buys nothing on a
  small static table and costs the simple "page 2 of 3" access pattern that
  fits area management.

## Consequences

Positive: log pages are stable under concurrent inserts; pagination cost is
flat regardless of depth; the index plan is fixed before the endpoint exists.

Negative / accepted honestly: keyset gives no total count and no random page
access — consumers walk forward from a cursor. The cursor's wire encoding
(opaque token vs explicit pair) is a Phase 4 implementation detail, not
constitutional.

## Concrete choices (Phase 4A, 2026-08-07 — the mechanism above made real)

- **Cursor contents**: position only — `(recorded_at, id)` of the last row.
  `recorded_at` travels as the timestamptz **text exactly as Postgres emits it**
  (`2026-08-07 18:45:25.889+00`): full microsecond round-trip, where a JS Date
  would truncate to milliseconds and could skip or repeat rows at a page
  boundary between microsecond-close rows.
- **Encoding**: base64url of a two-element JSON array. Opaque as a *contract*
  boundary, not a security one — both fields are pattern-validated on decode,
  so nothing hand-crafted reaches SQL.
- **Malformed/truncated cursor**: 400 with `malformed cursor: pass the
  nextCursor value from a previous response, unmodified`. Never a 500 (fields
  are validated before any cast), never a silent restart from the top.
- **Filters are re-sent, not baked into the cursor.** The cursor stays small
  and single-purpose, and visible query params are never silently overridden by
  hidden cursor state. Changing a filter mid-pagination is therefore *legal and
  well-defined*: the walk continues from the same `(recorded_at, id)` position
  under the new filter. Documented in the endpoint contract rather than
  detected and rejected.
- **End signal**: the service fetches `limit + 1` rows; `nextCursor` is `null`
  exactly when no further row exists — a result exactly one page long ends with
  `null`, no empty trailing page.
- **Page size**: default 50, maximum 500, values outside [1, 500] rejected
  with 400 — same numbers and rejection convention as `GET /areas`.
- **Index, added on evidence** (200k-row seed, plans in the migration and the
  Phase 4A report): unfiltered newest-first was a 41 ms parallel seq scan +
  top-N sort; `idx_logs_recorded_id (recorded_at DESC, id DESC)` turned it into
  a 0.34 ms index scan, the cursor predicate into a 0.05 ms index-only scan
  (`Index Cond: ROW(recorded_at, id) < ROW(...)`), and the time-range filter
  into a 0.02 ms index-only scan. The user/area-filtered walks were already
  sub-millisecond on the existing indexes (index scan + incremental sort for
  the id tiebreak) and gained nothing new.
