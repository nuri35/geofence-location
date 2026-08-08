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

## Addendum (2026-08-07, after the ADR 0007 measurement)

The presence-cache measurement (docs/PRESENCE_READ_MEASUREMENT.md) sharpened
this ADR's "until measured" qualifier into one coherent position on caching.
Presence proved a poor cache target: per-user, changed on every transition, and
readable only under the advisory lock — invalidation churn collapsed its hit
rate from 99.7% to 0.50–0.78 in the transition-heavy workload. The **area
polygons are the opposite on every axis**: near-static, small, identical for
every user, and read outside any lock. An in-process polygon cache invalidated
on `POST /areas` — exactly the "application-layer point-in-polygon" alternative
this ADR keeps open — would remove the spatial query from the request path
entirely, a larger saving than any presence cache could offer.

It stays unimplemented, deliberately:

1. The measured bottleneck is the Node app tier, not database access — a bare
   404 route ceilings at ~5,500 req/s while every strategy sits near 1,600, so
   removing this round trip runs into the same wall.
2. With multiple app instances, a polygon change must invalidate every
   instance's cache — that needs a broadcast signal (Redis pub/sub), a new
   architectural component, not a tuning change.
3. Building it without measuring would repeat exactly the mistake the
   presence-cache measurement caught.

The revisit condition above stands unchanged — when the per-request round trip
is a *measured* bottleneck — now with the added knowledge of **which** cache to
build when that day comes, and what it costs.

> Second annotation (2026-08-08): the cheap experiment that settles the revisit
> question without building anything — stub `findCoveringAreaIds` with a fixed
> result and re-run `scripts/measure-presence.mjs`. Throughput moving from
> ~1,600 toward ~3,000 req/s means the spatial round trip is worth removing;
> barely moving means it is noise under the Node ceiling.

> **Third annotation (2026-08-08) — the experiment above was run. The
> pre-registered criterion fired: the spatial round trip is worth removing.**
> Conditions: same harness, same box, same-session control (essential — machine
> state had drifted ~+20% since the original measurement, control that day:
> static c=500 1,986 req/s vs 1,605 originally). Stub: coordinate-aware fixed
> result (inside → the real area id, outside → `[]`, id cached at first call) so
> both workloads kept their true downstream work. Results, control → stub:
> static c=50/200/500: 1,970→2,905, 1,887→2,731, **1,986→2,835 (+43%)**;
> transition c=500: 1,506→2,258 (+50%). In the cost model's own units the
> removed round trip priced at **~0.16 ms of event-loop budget vs the ~0.12 ms
> a generic round trip predicts** — the model holds directionally and slightly
> understates this particular round trip, most plausibly because the spatial
> statement is the heaviest of the four (largest SQL text, unprepared,
> parameter-built geometry), not because round trips generally cost more. The
> discriminator, if it ever matters: replace the spatial query with `SELECT 1`
> — round trip kept, execution removed — and see which side of ~2,000 lands.
> Implications for the deferred candidates: an in-process polygon cache's upper
> bound is now measured (+40–50% single-box) and its risk profile is unchanged
> (low), so it moves **ahead of** the full one-round-trip fold in
> value-per-risk; the fold's ~2× projection is credible at the low end
> (~1.7×, since BEGIN/COMMIT are cheaper round trips than the spatial one) but
> its cost — the transition model in PL/pgSQL — is unchanged. Neither is built;
> the multi-instance invalidation question stands. Prediction record: the
> stated band (1,750–1,900) was beaten because it was anchored to the stale
> baseline; against the same-session control the gain matched the model's
> direction and exceeded its point estimate by ~35%.
