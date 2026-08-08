# geofence-location

A geofencing API built on NestJS + PostgreSQL/PostGIS. Users report coordinates
(`POST /locations`); when a user **enters** a predefined geographic area, exactly one
event is logged with user, area, and timestamp — under high concurrent load, without
duplicates. Areas are managed as GeoJSON polygons (`POST /areas`, `GET /areas`);
`GET /logs` (keyset-paginated) is the remaining planned endpoint.

Decisions and project state live in [CLAUDE.md](CLAUDE.md); reasoning lives in
[docs/ADR/](docs/ADR/README.md); working conventions live in [.claude/](.claude/README.md).

## Architecture — the five-minute version

**Entry is a transition, not a state.** A user sitting inside an area for ten minutes
must produce one log, not sixty — so every location report is compared against where
the user *was*, and only the difference is logged. A user can be inside several
overlapping areas; the transition is a set difference (entered = current \ previous),
which also makes a first-ever report from inside an area count as an entry with no
special case.

**Previous membership lives in PostgreSQL** (`user_area_presence`, composite primary
key `(user_id, area_id)`) — not in a cache — because the state must never disagree
with the log derived from it. Deriving state from the log itself fails on
exit-and-re-enter, and a cache-as-truth fails on expiry, on concurrent
read-modify-write, and on multi-instance races (all four failure modes are recorded in
[ADR 0002](docs/ADR/0002-presence-table-source-of-truth.md), which rejected the
original Redis-as-truth design).

**Concurrency is made safe by three layers in one transaction** per location report:

1. `pg_advisory_xact_lock(hashtext(user_id))` — first statement; serializes
   same-user requests (mobile retries make these a certainty), releases at commit.
2. `INSERT … ON CONFLICT (user_id, area_id) DO NOTHING RETURNING` — a log row is
   written **only** when the insert returns a row, so of two racing identical
   requests exactly one logs, enforced by the database, not application state.
3. Departed areas are deleted (no exit log — a declared non-goal); state and log
   commit atomically or not at all.

Point-in-polygon runs in PostGIS (`ST_Covers`, GIST-indexed — the boundary line
counts as inside, [ADR 0003](docs/ADR/0003-spatial-query-strategy.md)); polygons are
validated structurally at the DTO layer and geometrically with `ST_IsValid` before
any row is stored, plus a database `CHECK` constraint as backstop.

**The presence read was decided by measurement, not taste**
([ADR 0007](docs/ADR/0007-presence-read-strategy.md), full method and curves in
[docs/PRESENCE_READ_MEASUREMENT.md](docs/PRESENCE_READ_MEASUREMENT.md)). Three
implementations were built and compared under closed-loop load (10–500 in-flight,
10,000 users): a two-step baseline, a **folded** path (lock + presence read in one
round trip via a plpgsql function), and a Redis read-through **cache**. `folded` won
everywhere — +15–20% throughput over baseline in both workload shapes (e.g. 1,605 vs
1,393 req/s static, 1,394 vs 1,230 req/s transition-heavy at 500 in-flight). The
Redis cache was **built, measured, and removed**: it helps a static workload (+7% at
a 99.7% hit rate) but hurts under transitions (−13 to −18% below baseline —
invalidation churn, and the Redis hop sits inside the locked transaction by
correctness requirement), and review then found a correctness hole in the cache path
(a Redis outage spanning a transition leaves a stale key that can suppress a genuine
re-entry log — ADR 0007). The losing paths and the Redis infrastructure were removed;
`folded` is the only implementation, and the decision stays reversible through the
documents and git history. The bottleneck at saturation was the Node app tier, not
database access: the 10-connection pool sat mostly idle-in-transaction with zero
errors at every level. **Topology caveat**: these numbers were taken with generator,
app, Postgres and Redis on one box — same-host database, warm connection pool. A
remote database changes one comparison only: a cache would beat *two-step* (whose
presence read is its own round trip) as latency rises — but not `folded`, because
any presence cache must be read under the advisory lock, which is itself a Postgres
round trip; the cache adds a hop on top of that trip rather than replacing it.

**The measurement also showed presence was the wrong thing to cache.** Presence
changes on every transition, is per-user, and must be read under a lock —
invalidation churn is exactly what collapsed the hit rate from 99.7% to 0.50–0.78.
The right cache target is the **area polygons**: near-static, small, identical for
every user, read outside any lock. An in-process polygon cache invalidated on
`POST /areas` would remove the spatial query from the request path entirely — a
larger saving than anything the presence cache could offer. It is deliberately not
implemented: the measured bottleneck is the Node event loop, not database access (a
bare 404 route ceilings at ~5,500 req/s while every strategy sits near 1,600, so the
saved round trip runs into the same wall); with multiple app instances a polygon
change must invalidate every instance's cache, which needs a broadcast signal (Redis
pub/sub — a new architectural component, not a tuning change); and adding it without
measuring would repeat exactly the mistake the presence-cache measurement caught.
The standing revisit condition lives in [ADR 0003](docs/ADR/0003-spatial-query-strategy.md).

## Stack

| Component  | Choice                                          |
| ---------- | ----------------------------------------------- |
| Runtime    | Node.js >= 20                                   |
| Framework  | NestJS 11 (Express 5)                           |
| Language   | TypeScript 5 (strict)                           |
| Database   | PostgreSQL 16 + PostGIS 3.4 (`postgis/postgis`) |
| ORM        | TypeORM 0.3 (DataSource + migrations, no sync)  |
| Cache      | None — a Redis presence cache was evaluated by measurement and removed (ADR 0007) |
| Validation | class-validator / class-transformer, Joi (env)  |
| Testing    | Jest 29, Supertest (e2e, dedicated test DB)     |
| Local infra| Docker Compose                                  |

## Prerequisites

- Node.js 20 or newer and npm
- Docker with Compose v2

## Running locally

```bash
cp .env.example .env        # defaults work with the compose services as-is
docker compose up -d        # PostGIS with healthcheck
npm install
npm run migration:run       # PostGIS extension → areas → logs → presence → lock function
npm run start:dev
```

The API listens on `http://localhost:3000`. Health: `GET /health`. Swagger UI: `/docs`.

## Endpoints

| Endpoint | Behaviour |
| --- | --- |
| `POST /locations` | Report a position; returns 201 `{ enteredAreaIds: [...] }` — the entries this request produced, `[]` when nothing changed |
| `POST /areas` | Create an area from a GeoJSON Polygon (`[lng, lat]` order; ≤1000 vertices; `ST_IsValid`-gated with the reason in the 400) |
| `GET /areas` | List areas with full GeoJSON geometry, `limit`/`offset` |
| `GET /logs` | Entry log, newest first, keyset-paginated over `(recorded_at, id)` via an opaque cursor (`nextCursor`, null at the end); optional combinable filters `userId`, `areaId`, `from`/`to` on `recorded_at`; page size 50, max 500 |

## Error contract

Every error this API produces has one shape:

```json
{ "statusCode": 400, "timestamp": "2026-08-08T05:45:44.714Z", "path": "/locations", "message": "..." }
```

`message` is a string, or an array of strings for validation failures. This holds for
validation errors, unknown routes (404), malformed JSON bodies, oversized bodies
(413), and internal failures — where `message` is always the generic
`"Internal server error"`: nothing from the underlying exception (driver messages,
SQL fragments, connection details) ever reaches a client; the full detail goes to the
server log instead. One deliberate exception: `GET /health` returns Terminus's own
structured body in **both** directions — 200 healthy and 503 unhealthy — so the
per-dependency detail (`database: down`) survives exactly when an operator needs it.
The contract is pinned by `test/errors.e2e-spec.ts`.

**Transient overload returns `503` with `Retry-After: 5`** ([ADR 0009](docs/ADR/0009-connection-and-query-bounds.md)):
when a request exceeds the pool-acquire bound (2 s), the statement ceiling (5 s), or
its transaction is culled as idle (10 s), the response is
`503 {"statusCode":503, ..., "message":"Service temporarily unavailable, retry later"}`
with a `Retry-After` header. **Client guidance**: wait the header's value, then retry —
retrying `POST /locations` is safe by design (duplicate entries are impossible: the
`ON CONFLICT` arbiter absorbs them), and even without a retry a timed-out location
report self-heals on the next ping. Do not retry immediately; the header value is
chosen to land your retry after the stall that caused it.

## Scripts

| Script                   | Purpose                                             |
| ------------------------ | --------------------------------------------------- |
| `npm run start:dev`      | Start with file watching                            |
| `npm run build`          | Compile to `dist/` (with path-alias rewrite)        |
| `npm run lint`           | ESLint (type-checked) with autofix                  |
| `npm run format`         | Prettier over `src/`, `test/` and `scripts/`        |
| `npm test`               | Unit tests                                          |
| `npm run test:cov`       | Unit tests with coverage thresholds                 |
| `npm run test:e2e`       | e2e against a dedicated `geofence_test` database it provisions per run (compose must be up) |
| `npm run migration:generate` | `-- src/migrations/<Name>` to diff entities     |
| `npm run migration:run`  | Apply pending migrations                            |
| `npm run migration:revert` | Roll back the last migration                      |
| `node scripts/measure-presence.mjs` | ADR 0007 load-measurement harness (see docs/PRESENCE_READ_MEASUREMENT.md) |

## Project structure

```
src/
├── app.module.ts            # root module: config, TypeORM, modules, global filter/interceptor/pipe
├── main.ts                  # bootstrap: helmet, compression, Swagger
├── config/                  # ONLY place that reads process.env (namespaced, Joi-validated)
├── common/                  # global filter, response envelope interceptor, decorators
├── areas/                   # POST/GET /areas, GeoJSON validation, ST_Covers containment query
├── locations/               # POST /locations — the transition path (ADR 0002)
├── logs/                    # entry events: LogEntity + GET /logs (keyset pagination, ADR 0006)
├── presence/                # PresenceEntity — the source-of-truth membership table
├── health/                  # GET /health (Terminus, db ping)
└── migrations/              # extension → areas → logs → presence → lock/read function
test/                        # e2e specs + per-run provisioning of the geofence_test database
scripts/                     # measurement harness (measure-presence.mjs)
docs/                        # ADRs, SCOPE, ACCEPTANCE, measurement records
```

## Environment variables

Required variables have no fallback — the app refuses to start if one is missing.
`cp .env.example .env` provides working values for the compose services.

| Variable            | Required | Default       | Description                                  |
| ------------------- | -------- | ------------- | -------------------------------------------- |
| `NODE_ENV`          | no       | `development` | `development` \| `test` \| `production`      |
| `PORT`              | no       | `3000`        | HTTP port                                    |
| `POSTGRES_HOST`     | yes      | —             | Postgres host                                |
| `POSTGRES_PORT`     | yes      | —             | Postgres port (also used by compose mapping) |
| `POSTGRES_USER`     | yes      | —             | Postgres user                                |
| `POSTGRES_PASSWORD` | yes      | —             | Postgres password                            |
| `POSTGRES_DB`       | yes      | —             | Database name                                |
| `POSTGRES_POOL_SIZE` | no      | `10`          | Connections per instance; `N × poolSize ≤ max_connections − 10` (ADR 0009) |
| `POSTGRES_ACQUIRE_TIMEOUT_MS` | no | `2000`    | Pool-acquire bound; must be < statement timeout (ADR 0009) |
| `POSTGRES_STATEMENT_TIMEOUT_MS` | no | `5000`  | Server-side statement ceiling; must be < idle-txn timeout (ADR 0009) |
| `POSTGRES_IDLE_TXN_TIMEOUT_MS` | no | `10000`  | Kills transactions left idle by a hung app side (ADR 0009) |

The three timeouts are ordering-validated at boot — a misordered combination refuses
to start. The migration CLI deliberately carries none of these bounds.
