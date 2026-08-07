# ADR 0003 — Spatial query strategy: PostGIS with a GIST index, `ST_Covers`

- **Status**: Accepted
- **Date**: 2026-08-07

## Context

Every location report asks "which areas cover this point" — the hottest query in
the system. Polygons are stored as `geometry(Polygon, 4326)` per the
postgis-spatial skill (§2–3); the decisions here are where containment runs and
with which predicate.

## Decision

Point-in-polygon runs in PostgreSQL via PostGIS, with a GIST index on the
polygon column. The predicate is **`ST_Covers(area, point)`**, not
`ST_Contains`: a point exactly on the boundary line counts as inside. The skill
(§6) documents the distinction; the choice is made deliberately as a product
rule — a user standing on the fence line is in, not out, and does not owe their
entry to GPS noise nudging them across.

Polygons stay in the database **until the per-request round trip is a measured
bottleneck**. That qualifier is load-bearing: an in-memory polygon cache in the
application (invalidated on `POST /areas`) remains an available later step and
does not contradict this ADR.

## The performance claim — measured vs borrowed

The postgis-spatial skill's benchmark (0.388 ms indexed vs 70.3 ms sequential,
180×) measured **one polygon probed against 100,000 indexed points** — the
inverse of this system's hot query, which is one point against N indexed
polygons. That figure is evidence the index machinery works (the
support-function rewrite applies with the indexed column on either side, skill
§5); it is **not** a measurement of this workload and must not be cited as one.

The index is justified on scaling, not on the borrowed number: with tens of
areas a sequential scan over polygons is cheap and the planner may rightly skip
the index; as area count grows, the GIST bounding-box filter keeps per-request
cost roughly flat instead of linear in N. **A measurement of the real query
shape (one point vs N polygons, `EXPLAIN ANALYZE` showing `Index Cond`) is owed
in Phase 1** and belongs in that migration's verification trail.

> **Verification note (2026-08-07, Phase 1)** — real plan of the application's
> query, 10 polygons seeded:
> `Index Scan using idx_areas_boundary … Index Cond: (boundary ~ point) …
> Execution Time: 0.160 ms`. The support function rewrote `ST_Covers` into the
> bbox operator plus recheck — the query shape is index-rewritable as §5 of the
> postgis-spatial skill predicts. At-scale behaviour remains covered by the
> Phase 4 measurement items.

## Alternatives considered

- **Application-layer point-in-polygon** (polygons cached in process behind an
  R-tree) — rejected *for now*: it duplicates geometry semantics in a second
  engine, adds cache-invalidation on every area write, and optimizes a round
  trip not yet measured as a problem. The revisit condition is stated above; at
  ~10× the assumed load this is the known escape hatch.
- **`ST_Contains`** — rejected: it excludes the boundary (skill §6), making a
  point on the fence line "outside".
- **`ST_Intersects`** — rejected: it answers "touches at all", which silently
  diverges from "is inside" the day the tracked object is a shape rather than a
  point.
- **`geography` type** — rejected: containment is a topological test that needs
  no meters; at city scale the planar-vs-spheroid difference cannot flip a
  containment result beyond GPS accuracy, and `geometry` is faster with full
  TypeORM GeoJSON support (skill §2, §4). Distances in meters are still done by
  casting at the expression level (`::geography` with `ST_DWithin`).

## Consequences

Positive:

- One engine owns geometry; TypeORM provides the GeoJSON read/write pipeline
  and the GIST DDL (`@Index({ spatial: true })`, skill §4).
- Boundary semantics are a single deliberate rule, applied everywhere.

Negative / accepted honestly:

- Every location report is a database round trip, even when the point is far
  from every area.
- The postgis-spatial skill (§6) originally named `ST_Contains` as the project
  convention; it was corrected to `ST_Covers` in Phase 0 when this ADR landed,
  so skill and constitution agree.
- `ST_Covers` on shared boundaries means a point on the border between two
  adjacent areas is inside both — consistent with decision 5, but worth knowing
  when reading logs.
