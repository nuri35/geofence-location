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
