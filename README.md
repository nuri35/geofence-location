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

**The presence read strategy was decided by measurement, not taste**
([ADR 0007](docs/ADR/0007-presence-read-strategy.md), full method and curves in
[docs/PRESENCE_READ_MEASUREMENT.md](docs/PRESENCE_READ_MEASUREMENT.md)). Three
switchable implementations exist behind `PRESENCE_READ_STRATEGY`: a two-step
baseline, a **folded** path (lock + presence read in one round trip via a plpgsql
function), and a Redis read-through **cache**. Under closed-loop load (10–500
in-flight, 10,000 users): `folded` won everywhere — +15–20% throughput over baseline
in both workload shapes (e.g. 1,605 vs 1,393 req/s static, 1,394 vs 1,230 req/s
transition-heavy at 500 in-flight). Redis was implemented and measured, and **not
adopted as default**: it helps a static workload (+7% at a 99.7% hit rate) but hurts
under transitions (−13 to −18% below baseline — invalidation churn, and the Redis hop
sits inside the locked transaction by correctness requirement). The bottleneck at
saturation was the Node app tier, not database access: the 10-connection pool sat
mostly idle-in-transaction with zero errors at every level. **Topology caveat**: these
numbers were taken with generator, app, Postgres and Redis on one box — same-host
database, warm connection pool. A remote database (real network round trips) would
likely invert the cache result; that is exactly the condition under which to re-run
`scripts/measure-presence.mjs` and re-decide via the flag.

## Stack

| Component  | Choice                                          |
| ---------- | ----------------------------------------------- |
| Runtime    | Node.js >= 20                                   |
| Framework  | NestJS 11 (Express 5)                           |
| Language   | TypeScript 5 (strict)                           |
| Database   | PostgreSQL 16 + PostGIS 3.4 (`postgis/postgis`) |
| ORM        | TypeORM 0.3 (DataSource + migrations, no sync)  |
| Cache      | Redis 7 via ioredis (optional presence cache — measured, non-default) |
| Validation | class-validator / class-transformer, Joi (env)  |
| Testing    | Jest 29, Supertest (e2e, dedicated test DB)     |
| Local infra| Docker Compose                                  |

## Prerequisites

- Node.js 20 or newer and npm
- Docker with Compose v2

## Running locally

```bash
cp .env.example .env        # defaults work with the compose services as-is
docker compose up -d        # PostGIS + Redis with healthchecks
npm install
npm run migration:run       # PostGIS extension → areas → logs → presence → lock function
npm run start:dev
```

The API listens on `http://localhost:3000`. Health: `GET /health` (database is
critical; Redis is reported but never fails the endpoint). Swagger UI: `/docs`.

## Endpoints

| Endpoint | Behaviour |
| --- | --- |
| `POST /locations` | Report a position; returns 201 `{ enteredAreaIds: [...] }` — the entries this request produced, `[]` when nothing changed |
| `POST /areas` | Create an area from a GeoJSON Polygon (`[lng, lat]` order; ≤1000 vertices; `ST_IsValid`-gated with the reason in the 400) |
| `GET /areas` | List areas with full GeoJSON geometry, `limit`/`offset` |
| `GET /logs` | Planned (Phase 4): keyset pagination over `(recorded_at, id)` |

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
├── logs/                    # LogEntity (entry events; GET /logs lands in Phase 4)
├── presence/                # PresenceEntity (source of truth) + optional Redis read-through cache
├── health/                  # GET /health (Terminus: db critical, redis informational)
├── redis/                   # global ioredis provider, fail-fast tuned (REDIS_CLIENT token)
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
| `PRESENCE_READ_STRATEGY` | no  | `folded`      | ADR 0007 (measured): `folded` \| `two-step` \| `cache` |
| `POSTGRES_HOST`     | yes      | —             | Postgres host                                |
| `POSTGRES_PORT`     | yes      | —             | Postgres port (also used by compose mapping) |
| `POSTGRES_USER`     | yes      | —             | Postgres user                                |
| `POSTGRES_PASSWORD` | yes      | —             | Postgres password                            |
| `POSTGRES_DB`       | yes      | —             | Database name                                |
| `REDIS_HOST`        | yes      | —             | Redis host                                   |
| `REDIS_PORT`        | yes      | —             | Redis port (also used by compose mapping)    |
| `REDIS_PASSWORD`    | no       | *(empty)*     | Redis password; empty disables auth          |
