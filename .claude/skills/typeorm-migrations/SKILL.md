---
name: typeorm-migrations
description: Use when creating, editing, reviewing, running, or reverting a TypeORM migration, or changing anything under src/migrations/ or the database schema. Covers the naming convention, the down() policy, and how to prove a migration did what it claims.
---

# TypeORM migration workflow in this repo

TypeORM 0.3.31, DataSource-based CLI. The CLI entry is
`src/config/data-source.ts` (loads `.env` via dotenv, fails fast on missing
`POSTGRES_*` vars via `requireEnv` — running `npm run typeorm` without a `.env`
errors loudly by design).

## Hard rules

- `synchronize: false` and `migrationsRun: false` — set in
  src/config/typeorm.config.ts, the factory src/app.module.ts actually uses.
  The app never mutates schema; only `npm run migration:run` does. Never change
  either flag.
- **Executed migrations are immutable.** TypeORM records `(timestamp, name)` in the
  `migrations` table and never re-runs a recorded migration — editing one changes
  nothing in any database that already ran it. Fix-forward with a new migration.
- Fail loudly. No defensive guards to paper over failures. (The one deliberate
  `IF NOT EXISTS` is the postgis extension migration, where the extension may
  legitimately pre-exist — rationale in docs/ADR/0001.)

## Naming and shape

File: `<epoch-ms>-PascalCaseDescription.ts`, e.g.
`1786038977187-EnablePostgisExtension.ts`. Class: `PascalCaseDescription<epoch-ms>`
with a matching `name` property — TypeORM matches source to the `migrations` table
by that exact string. Get a timestamp with `date +%s%3N` (Bash). Timestamps order
the chain; a new migration's timestamp must be greater than all committed ones.

## Hand-written only — migration:generate is DISABLED (ADR 0008)

- **All migrations are written by hand.** `npm run migration:generate` refuses
  with an explanation. Reason (measured, not theoretical): two live schema
  objects are invisible to entity metadata — `chk_areas_boundary_valid` (CHECK,
  undeclared on the entity) and `idx_logs_recorded_id` (`recorded_at DESC, id
  DESC`; `@Index` cannot express DESC) — so generated SQL opens by DROPPING
  both, and its `down()` recreates the index with inverted column order and no
  DESC. Full evidence in docs/ADR/0008.
- Template: any existing migration in src/migrations/ — `queryRunner.query('…')`
  in `up()`, lint note: an empty `down()` returns `Promise.resolve()` (not
  `async` — `require-await` rejects await-less async). For spatial DDL check:
  `geometry(Type,4326)` modifier present, GIST index included.
- After adding a migration file, add it to the explicit MIGRATIONS list in
  test/global-setup.ts — a count guard there fails the e2e suite loudly if you
  forget (a missing index/constraint migration used to pass silently).
- Deliberate generate (large refactor only): `npm run typeorm -- migration:generate
  <path>`, then strip every statement touching the two objects above and review
  the rest line by line before committing.

## down() policy

`down()` must truly undo `up()` when that is safe (drop the table you created,
drop the index you added). It is a deliberate no-op — with a one-line comment
saying why — when reverting would destroy data or shared resources the migration
did not create. Existing example: dropping the postgis extension would
`CASCADE`-destroy every spatial column, and the Docker image pre-installs the
extension anyway, so its `down()` only removes the bookkeeping row (verified:
revert deletes the row, `ST_Contains` still works after).

## Prove it, don't trust it

After `npm run migration:run`, verify all three (real outputs from this repo's
verification runs):

```bash
# 1. Recorded?
docker exec geofence-postgres psql -U geofence -d geofence -c "SELECT * FROM migrations;"
#  id |   timestamp   |                name
# ----+---------------+-------------------------------------
#   1 | 1786038977187 | EnablePostgisExtension1786038977187

# 2. Did the DDL actually happen? Query the object itself, not the log:
#    extensions -> pg_extension; tables/indexes -> \d "table_name"
docker exec geofence-postgres psql -U geofence -d geofence -c "SELECT extname FROM pg_extension;"

# 3. Round-trip: revert must exit 0 and leave the DB usable, then re-run.
npm run migration:revert && npm run migration:run
```

For a from-nothing check (what a reviewer's clean clone does):
`docker compose down -v && docker compose up -d`, wait for healthy, then
`migration:run` — this repo's chain was verified that way; postgres reports
healthy in ~7 s from an empty volume.

Gotcha already hit here: a `migration:run` auth failure
(`password authentication failed`) with correct-looking credentials meant the
connection reached a **different Postgres** — a native service on the default
5432 port. Check `netstat -ano | grep :5432` before debugging credentials; this
machine's `.env` uses 5433 for that reason.
