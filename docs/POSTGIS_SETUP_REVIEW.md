# PostGIS setup review

> **Update 2026-08-06**: §5 items 1–2 have been implemented — the extension now
> lives in migration `1786038977187-EnablePostgisExtension`, `init.sql` and its
> mount are deleted, and the healthcheck uses `-h 127.0.0.1`. See
> `docs/ADR/0001-postgis-extension-via-migration.md`. References to `init.sql`
> below describe the setup as it was when reviewed.

Reviewed 2026-08-06 against commit `8b6b111`, using `.claude/skills/postgis-spatial/SKILL.md`.
Scope: docker-compose.yml, docker/postgres/init.sql, src/config/*, .env.example.

## 1. Does it work?

Yes. Verified **by execution**, not by reading:

- `docker compose down -v && docker compose up -d` from scratch: postgres healthy in
  ~7 s, redis healthy. Fresh volume, full re-init.
- `SELECT PostGIS_Version()` → `3.4 USE_GEOS=1 USE_PROJ=1 USE_STATS=1`;
  `SELECT ST_Contains(polygon, point)` → `t`. PostGIS 3.4.3 on PostgreSQL 16.4.
- `npm run migration:run` → exit 0, `No migrations are pending`, migrations table
  created over TCP from the host (port 5433 on this machine, see §4).
- `GET /health` → 200 with `database.status: "up"` (run earlier this session against
  the same containers).
- Container first-boot logs show the exact init order: the image's own
  `10_postgis.sh` loads PostGIS into the `geofence` database, then our `init.sql`
  runs and prints `NOTICE: extension "postgis" already exists, skipping`.

Verified **by reading only** (not executed): CI behavior (no CI exists yet), the
entrypoint's init-phase `listen_addresses=''` race (read from
`/usr/local/bin/docker-entrypoint.sh:270`; did not trigger on this machine — the
vulnerable window on this boot was ~1.6 s against a 5 s healthcheck interval).

## 2. What is fragile

- **Our `init.sql` is dead weight today — and that's the fragility.** The
  `postgis/postgis` image already runs `CREATE EXTENSION postgis` (plus topology,
  fuzzystrmatch, tiger_geocoder) into `$POSTGRES_DB` on first boot. Proven by the
  boot log above. Consequence: if the `init.sql` mount is broken, renamed, or
  dropped, **nothing fails** — the image masks it. The file provides no protection
  in the one scenario it would matter (someone switches to plain `postgres:16`),
  because nobody will have noticed whether it was ever executing.
- **`docker compose down -v`**: safe. Verified — init re-runs on the empty volume
  and everything comes back green. Data is gone, which is the point of `-v`.
- **Fresh clone**: works *without* a `.env` file — compose falls back to
  `${VAR:-default}` and the app's Joi defaults match. Verified indirectly (this
  machine's `.env` only changes the port). One real trap: init scripts run **only on
  an empty volume**, so a reviewer who edits `init.sql` and re-runs `up -d` will see
  no effect and no error. That is the classic silent-not-run failure documented in
  the skill §1.
- **CI with no volume**: init will run (empty volume every time), so PostGIS will be
  present. The realistic CI risks are (a) the ~1 GB image pull, and (b) the
  healthcheck race: `pg_isready` without `-h` uses the unix socket and can pass
  against the init-phase server, which then restarts. Small window, real race.
  Mitigation is one flag: `pg_isready -h 127.0.0.1 -U … -d …` forces TCP, which only
  answers once the final server is up.
- **Extension is per-database.** Anything that creates another database (e2e test
  DB, a `_test` database in CI) does not automatically get PostGIS unless created
  from `template_postgis`. Nothing in the repo handles this yet; it will bite the
  first time tests get their own database.

## 3. init.sql vs a TypeORM migration

**Recommendation: add migration #1 as `CREATE EXTENSION IF NOT EXISTS postgis;`
and treat it as the authoritative source of the extension. Keep the compose mount
or delete it — it no longer matters once the migration exists; I'd delete it to
remove the false signal that it does something.**

Reasoning, not options: this project's contract with a reviewer is
`docker compose up -d && npm install && npm run migration:run && npm run start:dev`.
Everything the schema needs should therefore live in the migration chain — that is
the only mechanism that runs on *every* database the project ever points at
(reviewer's clean clone, CI's throwaway DB, a future managed Postgres), while
init.sql runs only inside this one Docker image on first boot of an empty volume.
`IF NOT EXISTS` makes it a no-op where the image already did the work, and
`migration:revert` order is unaffected since it's first in the chain.

The trade-off being accepted: `CREATE EXTENSION` requires elevated privileges. In
this compose setup the app user is the superuser, so it just works. On managed
platforms (RDS, Cloud SQL) it also works because they allowlist postgis for the
master user — but if this app ever connects as a restricted user that isn't the
schema owner, migration #1 fails and the extension has to be provisioned
out-of-band. That is a deployment-time concern this short-lived project does not
have, and it is a *loud* failure, unlike the silent one we have now.

## 4. Other things that will cause pain

- **Port 5432 collision (already bit us).** This machine runs a native
  PostgreSQL 15 service on 5432; with the default port, `migration:run` failed with
  `password authentication failed for user "geofence"` — against the *wrong server*,
  which is a maximally misleading error. Local `.env` now uses 5433;
  `.env.example` documents the trap. Any reviewer with a local Postgres will hit
  the identical symptom if they use defaults.
- **Healthcheck depth.** `pg_isready` proves the postmaster answers, not that the
  database is usable. Adding `-h 127.0.0.1` fixes the TCP/socket race (§2) cheaply.
  Going further (e.g. `psql -c 'SELECT postgis_version()'` as the check) is
  possible but unnecessary here — Terminus pings the DB at the app layer anyway.
- **No pool or timeout configuration.** TypeORM passes pg defaults: pool max 10,
  no `statement_timeout`, no connection timeout. Fine for dev and a review; the
  first runaway spatial query in anything like production would hold a connection
  forever. Not worth fixing now, worth knowing.
- **Timezone is sane.** Container reports `Etc/UTC` (verified). Just keep future
  entity timestamps `timestamptz`, never `timestamp`.
- **`migrationsRun: false` + `synchronize: false`** (read from
  `src/config/typeorm.config.ts`, the factory `app.module.ts` actually uses): the
  app never mutates schema on boot. Correct choice; the cost is that a reviewer who
  skips `npm run migration:run` gets runtime errors once real tables exist. The
  README run order already covers this.
- **e2e tests share the dev database.** Today they only hit `/health`; the day a
  test writes rows it will be writing into the dev DB. Combined with the
  per-database extension issue (§2), test-database provisioning is a known future
  chore — use `CREATE DATABASE … TEMPLATE template_postgis` when it comes.

## 5. Prioritized changes

**Fix now (cheap, prevents silent breakage):**
1. Add migration #1: `CREATE EXTENSION IF NOT EXISTS postgis;` — makes a clean
   clone self-contained regardless of image behavior. Remove `init.sql` and its
   mount at the same time.
2. Add `-h 127.0.0.1` to the postgres healthcheck to close the socket/TCP race.

**Before the first spatial query lands:**
3. Add `@types/geojson` (and use its `Polygon`/`Point` types) — the entity column
   pattern in the skill depends on it and it is not installed.
4. Every spatial column ships with `@Index({ spatial: true })` in the same
   migration, and the PR includes an `EXPLAIN ANALYZE` showing `Index Cond` —
   the measured penalty is 180× at only 100 k rows (skill §5).
5. DTO validation for polygon input: closed rings, lat/lng ranges, `ST_IsValid`
   gate (skill §7). Invalid polygons insert silently and then return wrong answers.

**Safe to ignore for a short-lived project:**
6. Pool sizing, statement timeouts, connection timeouts.
7. Deeper healthchecks than `pg_isready -h 127.0.0.1`.
8. Dedicated test database provisioning — until a test actually writes data.

Bottom line: the setup genuinely works from a clean clone today — verified, not
assumed — but it works because the Docker image papers over the extension question.
Items 1–2 move that guarantee into the project itself; nothing else is urgent.
