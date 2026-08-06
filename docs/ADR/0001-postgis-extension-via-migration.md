# ADR 0001 — Provision the PostGIS extension via a TypeORM migration

- **Status**: Accepted
- **Date**: 2026-08-06

## Context

The scaffold originally enabled PostGIS two ways at once: the `postgis/postgis:16-3.4`
image's own initdb script loads the extension into `$POSTGRES_DB` on first boot, and a
project-owned `docker/postgres/init.sql` (`CREATE EXTENSION IF NOT EXISTS postgis;`)
was mounted into `/docker-entrypoint-initdb.d/`. The setup review
(`docs/POSTGIS_SETUP_REVIEW.md`) proved by reading the first-boot logs that the
project's file was a no-op (`NOTICE: extension "postgis" already exists, skipping`)
and, worse, that a broken or missing mount would fail silently because the image
masks it. Init scripts also only run on an empty data volume, so edits after first
boot silently do nothing. This project's contract with a reviewer is
`docker compose up -d && npm run migration:run && npm run start:dev` from a clean
clone — schema prerequisites should live in the one mechanism that runs against
every database the project ever points at.

## Decision

The first migration in the chain, `1786038977187-EnablePostgisExtension`, runs
`CREATE EXTENSION IF NOT EXISTS postgis;`. It is the authoritative provisioning
step. `docker/postgres/init.sql` and its compose volume mount are deleted.

`down()` is a deliberate no-op: `DROP EXTENSION postgis CASCADE` would destroy every
spatial column in the database, and on this image the extension predates the
migration anyway (the image installs it at initdb), so dropping it would remove
something the migration did not create. Reverting this migration only removes its
bookkeeping row.

## Alternatives considered

- **init SQL mounted into the container (status quo)** — rejected. It runs only on
  first boot of an empty volume, never errors when the mount is missing or the file
  is edited later, and on this image it is always a no-op, so its breakage is
  undetectable. The review demonstrated this failure mode from the actual boot log.
- **Relying on the postgis/postgis image alone** — rejected. It works, but the
  guarantee is a property of one Docker image, not of the project. Any other
  environment — CI service container with a different image, a locally installed
  Postgres, a managed instance, a test database created outside `template_postgis` —
  gets no extension and fails at the first spatial query instead of at migration
  time.
- **Provisioning the extension in infrastructure (Terraform/Ansible/DBA runbook)** —
  rejected for this repository. There is no infrastructure layer here; the database
  a reviewer runs is created by `docker compose up` seconds before the migration
  runs. An infra step would be a second place to keep in sync with nothing to own
  it. This is the right answer for managed production databases (see Consequences),
  not for this project.

## Consequences

Positive:

- A clean clone is self-contained: `migration:run` guarantees the extension on any
  Postgres the config points at, and failure is loud (the migration errors) instead
  of silent (an init script that never ran).
- One fewer moving part: no mounted SQL, no `docker/` directory, no dependency on
  entrypoint init ordering.
- The extension requirement is now visible in the schema history, ordered before
  any future spatial DDL.

Negative / accepted honestly:

- `CREATE EXTENSION` requires elevated privileges. In managed Postgres (RDS,
  Cloud SQL, Azure) extension creation is often an infra/DBA concern: it works for
  the master user on allowlisted extensions but fails for a restricted application
  role. **This decision is scoped to a self-hosted database that a reviewer runs
  from a clean clone**, where the app user is the container's superuser. If this
  project ever targets managed Postgres with a restricted role, extension
  provisioning moves to infrastructure and this migration's `IF NOT EXISTS` makes
  it a harmless no-op there.
- On this specific image the migration is redundant (the image pre-installs the
  extension). The redundancy is the safety net, not waste.
- `migration:revert` cannot undo the extension (no-op `down()` by design).

## Verification trail

All executed 2026-08-06 from a destroyed volume (`docker compose down -v`), real
output in the task log:

1. Fresh `docker compose up -d` → postgres healthy with the new
   `pg_isready -h 127.0.0.1` TCP healthcheck.
2. Pre-migration: `SELECT PostGIS_Version()` already returns 3.4 — stated plainly:
   on this image the extension exists before the migration; the migration is a no-op
   here and the guarantee for every other environment.
3. `npm run migration:run` → exit 0, `EnablePostgisExtension1786038977187` recorded
   in the `migrations` table (row shown in log).
4. `npm run migration:revert` → removes the row, database remains usable
   (PostGIS still active), `migration:run` re-applies cleanly.
5. `build`, `lint`, `test`, `test:e2e` green; `GET /health` 200 with database up.
