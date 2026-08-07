---
name: postgis-spatial
description: PostGIS + TypeORM spatial conventions for this project. Use when adding or reviewing any spatial column, migration, query, index, or geo input validation.
---

# PostGIS spatial conventions

Verified 2026-08-06 against this project's actual stack, by execution (not memory):

| Component | Verified version | How verified |
| --- | --- | --- |
| Image | `postgis/postgis:16-3.4` | docker-compose.yml + running container |
| PostgreSQL | 16.4 (Debian) | `SELECT version()` in container |
| PostGIS | 3.4.3 (GEOS 3.9.0, PROJ 7.2.1) | `SELECT postgis_full_version()` |
| TypeORM | 0.3.31 | `npm ls typeorm` + reading `node_modules/typeorm` source |
| pg driver | 8.22.0 | `npm ls pg` |

Everything below labeled **verified** was executed against this container or read from
the installed TypeORM source at the file:line cited. Unverified items are marked.

## 1. Extension setup

Where `CREATE EXTENSION` runs today (both verified in the running container):

1. **Authoritative: migration `1786038977187-EnablePostgisExtension`** runs
   `CREATE EXTENSION IF NOT EXISTS postgis;` as the first migration in the chain.
   This is what guarantees the extension on any database the project points at
   (clean clone, CI, non-Docker Postgres). Its `down()` is a deliberate no-op —
   dropping the extension would cascade-destroy every spatial column.
2. Redundantly, the image ships `/docker-entrypoint-initdb.d/10_postgis.sh`, which
   creates a `template_postgis` database and loads `postgis`, `postgis_topology`,
   `fuzzystrmatch`, `postgis_tiger_geocoder` into **both** `template_postgis` and
   `$POSTGRES_DB` on first boot. On this image the migration is therefore a no-op;
   do not rely on the image behavior — it exists only inside this one image.

If you ever mount custom SQL into `/docker-entrypoint-initdb.d/` again, know what
makes init scripts **silently not run** (properties of the official entrypoint,
verified by reading `/usr/local/bin/docker-entrypoint.sh`):

- The data volume is non-empty. Init scripts run **only on first boot with empty
  `PGDATA`**. Editing a mounted script after the volume exists does nothing until
  `docker compose down -v`.
- The file is mounted to the wrong path or not mounted at all — no error, just no
  execution. Check with `docker exec geofence-postgres ls /docker-entrypoint-initdb.d/`.
- A `.sql` file with an error aborts init (entrypoint runs `set -e`); a file the
  entrypoint doesn't recognize (wrong extension) is skipped.

Verify PostGIS is actually active (run this, don't assume):

```bash
docker exec geofence-postgres psql -U geofence -d geofence \
  -c "SELECT extname, extversion FROM pg_extension;" \
  -c "SELECT PostGIS_Version();"
```

Expected: `postgis | 3.4.3` in the list. A missing row means the extension is not
installed **in this database** — `CREATE EXTENSION` is per-database, not per-cluster.

## 2. `geometry` vs `geography`

- `geometry`: planar math in the SRID's units. For SRID 4326 that unit is
  **degrees**. Fast, full function coverage, what TypeORM's GeoJSON pipeline targets.
- `geography`: geodetic math on the WGS84 spheroid, results in **meters**. Correct
  over long distances, slower, smaller function set.

Verified demonstration (Istanbul → Ankara, same two points):

```sql
SELECT ST_Distance(ST_SetSRID(ST_MakePoint(28.98, 41.01), 4326),
                   ST_SetSRID(ST_MakePoint(32.85, 39.93), 4326)) AS geometry_degrees,
       ST_Distance(ST_SetSRID(ST_MakePoint(28.98, 41.01), 4326)::geography,
                   ST_SetSRID(ST_MakePoint(32.85, 39.93), 4326)::geography) AS geography_meters;
--  geometry_degrees  | geography_meters
-- -------------------+------------------
--  4.017872571398949 |  349383.16265451
```

**This project uses `geometry(…, 4326)` for city-scale geofence polygons.** Reason:
point-in-polygon containment is a topological test — it does not need meters, and at
city scale (< ~50 km) the planar-vs-spheroid difference cannot flip a containment
result except within centimeters of the boundary, which GPS accuracy already exceeds.
`geometry` is faster, GIST-indexed the same way, and is the type TypeORM's
GeoJSON insert/select transformation is built around. Cast to `::geography` only at
the expression level when a distance in meters is required (e.g. "within N meters"):

```sql
WHERE ST_DWithin(geom::geography, $1::geography, 500)  -- 500 meters, index-usable
```

## 3. SRID discipline

Use **4326** (WGS84 lng/lat) everywhere: it is what GPS produces and what GeoJSON
requires (RFC 7946 fixes GeoJSON to WGS84). Do not mix in 3857 (web mercator) —
that is a display projection.

Mismatch does not corrupt silently between differing declared SRIDs — it errors
(verified):

```sql
SELECT ST_Contains(ST_GeomFromText('POLYGON((0 0, 0 10, 10 10, 10 0, 0 0))', 4326),
                   ST_SetSRID(ST_MakePoint(5, 5), 3857));
-- ERROR:  contains: Operation on mixed SRID geometries (Polygon, 4326) != (Point, 3857)
```

The dangerous case is SRID **0**: `ST_MakePoint(x, y)` alone produces SRID 0, and
`geometry` columns declared without a type modifier accept any SRID. Declare SRID in
all three places:

1. **Column**: `geometry(Polygon, 4326)` — the type modifier makes Postgres reject
   inserts with any other SRID. This comes from TypeORM's `srid: 4326` option.
2. **Inserts**: `ST_SetSRID(...)` / `ST_GeomFromText('...', 4326)` /
   `ST_GeomFromGeoJSON(...)` (GeoJSON defaults to 4326). TypeORM entity saves do this
   for you (see §4); raw SQL does not.
3. **Query parameters**: every geometry you build inside a `WHERE` clause needs its
   SRID stated, e.g. `ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)`. A bare
   `ST_MakePoint` parameter against a 4326 column is the mixed-SRID error above.

## 4. TypeORM specifics (verified in node_modules/typeorm@0.3.31 source)

Column declaration:

```ts
import { Polygon, Point } from 'geojson'; // @types/geojson — installed (devDependency since Phase 1)

@Column({ type: 'geometry', spatialFeatureType: 'Polygon', srid: 4326 })
area: Polygon;

@Index({ spatial: true })
@Column({ type: 'geometry', spatialFeatureType: 'Point', srid: 4326 })
location: Point;
```

`spatialFeatureType` + `srid` exist on `ColumnOptions` (ColumnOptions.d.ts:159,163)
and produce the DDL type modifier `geometry(Polygon,4326)`.

What TypeORM **does** handle automatically:

- **Read path**: spatial columns in entity selects are wrapped as
  `ST_AsGeoJSON("col")::json` (SelectQueryBuilder.js:1634) — entity properties come
  back as parsed GeoJSON objects.
- **Write path**: `repository.save()` / insert & update query builders bind values as
  `ST_SetSRID(ST_GeomFromGeoJSON($n), 4326)::geometry` when `srid` is set
  (InsertQueryBuilder.js:1047, UpdateQueryBuilder.js:368). You assign a GeoJSON
  object; TypeORM handles conversion and SRID.
- **Index DDL**: `@Index({ spatial: true })` emits
  `CREATE INDEX ... USING GiST (...)` (PostgresQueryRunner.js:2442), and schema diff
  tracks `spatialFeatureType`/`srid` changes (PostgresQueryRunner.js:1051).

What TypeORM does **NOT** handle:

- **`.where()` parameters are never transformed.** Only column *values* in
  insert/update get the GeoJSON treatment. Spatial predicates must be written as raw
  SQL with explicit `ST_*` calls and SRID:
  ```ts
  qb.where('ST_Contains(fence.area, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326))', { lng, lat })
  ```
  There is no find-operator for spatial predicates; `find({ where: { area: ... } })`
  cannot express containment.
- **No GIST index unless you ask.** A spatial column without `@Index({ spatial: true })`
  gets no index — every query seq-scans (see §5 for the measured cost).
- **No geometry validation.** Invalid polygons (self-intersections, etc.) insert
  fine; PostGIS then returns wrong-looking results silently (see §7).
- **Raw results skip GeoJSON conversion.** `getRawMany()` / `dataSource.query()`
  return hex EWKB strings (`0103000020E6100000...`) — wrap with `ST_AsGeoJSON`
  yourself in raw queries.
- Sharp edge: always eyeball `migration:generate` output for spatial columns —
  the generated DDL is usually right, but the `spatial_ref_sys` table and postgis
  system objects must never end up in a generated drop (TypeORM special-cases
  `spatial_ref_sys` in PostgresQueryRunner.js:1634, but review anyway).

## 5. Indexing

Syntax (raw SQL and what `@Index({ spatial: true })` generates):

```sql
CREATE INDEX geofence_area_idx ON geofence USING GIST (area);
```

Measured on this container — 100 000 random points, `geometry(Point,4326)`,
polygon containment query. **With GIST index** (verified, full real plan):

```
Aggregate  (cost=2749.83..2749.84 rows=1 width=8) (actual time=0.349..0.350 rows=1 loops=1)
  ->  Bitmap Heap Scan on tmp_spatial_check  (actual time=0.115..0.342 rows=199 loops=1)
        Filter: st_contains('0103...'::geometry, geom)
        Heap Blocks: exact=176
        ->  Bitmap Index Scan on tmp_spatial_check_geom_idx  (actual time=0.092..0.092 rows=199 loops=1)
              Index Cond: (geom @ '0103...'::geometry)
Execution Time: 0.388 ms
```

**Without index**, same query (verified):

```
Aggregate  (actual time=58.558..58.559 rows=1 loops=1)
  ->  Seq Scan on tmp_spatial_check  (actual time=46.988..58.515 rows=199 loops=1)
        Filter: st_contains('0103...'::geometry, geom)
        Rows Removed by Filter: 99801
Execution Time: 70.312 ms
```

180× on 100k rows; the gap grows linearly with table size. The tell-tale of a good
plan is the **`Index Cond: (geom @ ...)`** line: PostGIS support functions rewrite
`ST_Contains(poly, geom)` into an indexable bounding-box operator plus an exact
recheck filter. This works with the indexed column on *either* side of the call.

The planner will **not** use the index when:

- No GIST index exists (obviously — but TypeORM won't create one for you, §4).
- The indexed column is wrapped in an expression the support function can't see
  through, e.g. `ST_Contains(poly, ST_Buffer(geom, 0.01))` — index only helps via an
  expression index on the same expression.
- `ST_Distance(a, b) < x` is used instead of `ST_DWithin(a, b, x)` — `ST_Distance`
  in a comparison is not indexable; `ST_DWithin` is.
- The table is small enough that a seq scan is cheaper (planner's call; not a bug).

Prove it every time a spatial query lands: `EXPLAIN ANALYZE <query>` and look for
`Index Cond` vs `Seq Scan` + `Rows Removed by Filter`.

## 6. Query patterns: point-in-area

For "is this point inside this geofence area":

- **Use `ST_Covers(area, point)`** — true when the point is in the interior
  *or exactly on the boundary*. This is the project convention (CLAUDE.md
  decision 2, ADR 0003): the fence line counts as inside, so a user standing
  on it does not owe their entry to GPS noise. `ST_Contains(area, point)` is
  the interior-only variant — do not use it here; it excludes the boundary.
- `ST_Within(point, area)` is the *same test with arguments reversed*
  (`ST_Within(A, B) ≡ ST_Contains(B, A)`). Not wrong — but pick one convention and
  stick to it, because for non-point geometries swapping arguments silently inverts
  the question and both orders type-check.
- `ST_Intersects(area, point)` differs from Contains only for points exactly **on
  the boundary** (Intersects = true there, Contains = false). Performance is the same
  (both are index-rewritten, verified plan above). It becomes semantically wrong the
  day the tracked object is a shape instead of a point: Intersects answers "touches
  at all", not "is inside". Boundary inclusion is already provided here by the
  `ST_Covers` convention above — never reach for Intersects to get it.

For radius queries use `ST_DWithin(geom::geography, $point::geography, meters)`,
never `ST_Distance(...) < meters` (§5).

## 7. Validation at the boundary

Reject bad polygons in the DTO/service layer before they reach the database.
Postgres catches some problems and silently accepts others — verified behavior:

- **Unclosed ring — hard error at parse time:**
  ```
  SELECT ST_GeomFromText('POLYGON((0 0, 0 10, 10 10, 10 0))', 4326);
  ERROR:  geometry contains non-closed rings
  ```
  GeoJSON rings must repeat the first coordinate as the last.
- **Self-intersection — inserts fine, then lies.** A bowtie polygon stores without
  error; `ST_IsValid` flags it, and containment gives silently wrong answers:
  ```
  SELECT ST_IsValid(g), ST_IsValidReason(g) FROM (SELECT ST_GeomFromText(
    'POLYGON((0 0, 10 10, 10 0, 0 10, 0 0))', 4326) AS g) s;
  --  f | Self-intersection[5 5]
  SELECT ST_Contains(<that bowtie>, ST_SetSRID(ST_MakePoint(5, 5), 4326));
  --  f      ← the visual "center" reports outside; no error, no notice in app code
  ```
  Gate writes with `ST_IsValid($1)` (or a `CHECK (ST_IsValid(area))` constraint) and
  return `ST_IsValidReason` in the 400 response. Do not auto-repair with
  `ST_MakeValid` on user input — it changes the shape the user drew.
- **Coordinate order.** GeoJSON is `[lng, lat]`. A swapped point doesn't error —
  it is simply somewhere else (verified: Istanbul with swapped axes falls outside a
  Turkey bounding box). Validate ranges at the DTO layer: `lat ∈ [-90, 90]`,
  `lng ∈ [-180, 180]`; any |value| > 90 in the latitude slot catches most swaps.
  There is no reliable in-band check when both values are < 90 — the axis order
  contract has to be enforced at the API boundary, not detected later.

## 8. Common mistakes, by symptom

| Symptom (what you actually see) | Cause |
| --- | --- |
| `ERROR: Operation on mixed SRID geometries (…, 4326) != (…, 0)` | Query param built with bare `ST_MakePoint` — no `ST_SetSRID` (§3) |
| `ERROR: geometry contains non-closed rings` | Polygon ring's last coordinate ≠ first (§7) |
| Every point reports outside a fence that looks correct on a map | lng/lat swapped somewhere — GeoJSON is `[lng, lat]` (§7) |
| Radius filter matches nothing (or everything) | `geometry` distance is in degrees, not meters — 349 km ≈ 4.02° (§2) |
| Spatial query slow; `EXPLAIN` shows `Seq Scan` + `Rows Removed by Filter` | No GIST index, or predicate not index-rewritable (§5) |
| A point visually inside a polygon returns `ST_Contains = false`, no error | Stored polygon is invalid (self-intersection) — `ST_IsValid` gate missing (§7) |
| Works locally, `extension "postgis" does not exist` in CI / fresh env | Extension is per-database and init scripts only run on an empty volume; the target database never got `CREATE EXTENSION` (§1) |
| Raw query returns `0103000020E6100000…` instead of coordinates | Raw results bypass TypeORM's `ST_AsGeoJSON` wrapping (§4) |
| First boot: container `healthy` but TCP connections refused for a moment | Entrypoint's init-phase server runs with `listen_addresses=''` (socket only); socket `pg_isready` can pass before the real server starts (verified in entrypoint line 270; race not observed on this machine — window was ~1.6 s) |
