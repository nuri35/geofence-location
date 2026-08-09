---
name: testing-verification
description: Use when writing tests, running the test suites, or verifying a change is actually green before claiming it is — includes the exact command chain and the stale-dev-server trap that already produced a nearly-false pass in this repo.
---

# Testing and verification in this repo

Jest 29 + ts-jest, Supertest 7. Two suites with different trust models.

## Unit tests — `npm test`

- Config: `jest` block in package.json. `rootDir: src`, specs colocated as
  `*.spec.ts` next to the code they test. Path aliases mapped via
  `moduleNameMapper`.
- What gets mocked: injected Nest services, via `Test.createTestingModule` with
  `useValue` doubles — see health.controller.spec.ts (mocks `HealthCheckService`
  and `TypeOrmHealthIndicator`). What does NOT get mocked: cheap real
  collaborators — response-transform.interceptor.spec.ts uses a **real
  `Reflector`** against genuinely-decorated test classes, so the metadata path is
  actually exercised.
- Coverage thresholds are deliberately low (10% global) — scaffold-stage values.
  Raise them when domain code lands; do not delete them.

## e2e tests — `npm run test:e2e`

- Config: test/jest-e2e.json, specs in test/. These boot the **full AppModule
  against the live compose Postgres** — no DB mocking. Preconditions: containers
  healthy (`docker compose ps`) and a valid `.env` (missing required vars abort
  the boot by design).
- test/app.e2e-spec.ts asserts the raw Terminus `/health` shape AND the absence of
  the envelope (`not.toHaveProperty('data')`) — because the envelope wrongly
  wrapping health was a real regression class here. When an endpoint's shape is
  part of a contract, assert what must NOT be there too.
- e2e runs against a **dedicated `geofence_test` database**, dropped, recreated and
  migrated per run by test/global-setup.ts (the real migration chain guarantees
  PostGIS — not `template_postgis`, which is an image-specific artifact);
  test/setup-env.ts points the app's config at it. The dev database is never
  touched by tests. New migrations must be added to the explicit MIGRATIONS list
  in global-setup.ts — a missing table in e2e is the reminder.
- The presence read has exactly one implementation (folded, ADR 0007) — the
  strategy flag, the Redis cache, and the Redis container are gone, so there is
  no Redis-down verification any more and the old "worker failed to exit"
  ioredis teardown nuisance went with them.
- **e2e specs share one database AND one coordinate plane.** A spatial collision
  broke the suite once (2026-08-07): a logs seed area overlapped the locations
  cascade area, and `ST_Covers` counts the shared corner. Claimed lng ranges:
  locations.e2e-spec owns 0..15 and 100..102, areas.e2e-spec 0..30, logs
  150..170, spatial-equivalence.e2e-spec 59..81, area-snapshot.e2e-spec
  105..115, presence-cache.e2e-spec 120..130, stale-presence.e2e-spec 131..134,
  redis-down.e2e-spec 135..145, bounds.e2e-spec 46..48, worker-loop.e2e-spec
  174..176, worker-resilience.e2e-spec 177..179, worker-parallelism.e2e-spec
  32..34, worker-presence-memory.e2e-spec 36..38 — a new spec takes an
  unclaimed range and records it here.
- **The e2e suite runs serially (`maxWorkers: 1` in jest-e2e.json) since Phase
  N3.** Two interference classes forced it: spec files sharing a worker leak
  `process.env` mutations into the next file's app boot (specs that override
  env restore it in afterAll — keep doing that), and the logs pagination
  invariants walk the SHARED table, so concurrent suites' inserts land inside
  the walk. Serial cost measured at ~21 s vs ~16 s parallel; determinism won cheap.
- **POST /locations publishes since N4B (ADR 0015)** — transition semantics are
  exercised at SERVICE level (`app.get(LocationsService).report(...)`) in the
  acceptance/N3 specs; HTTP specs assert only what still lives at HTTP
  (validation, accuracy gate, the 202 publish contract in
  locations-publish.e2e-spec, which also asserts real broker placement). The
  app now REQUIRES a healthy RabbitMQ to boot (passive exchange verify) — a
  down broker fails every e2e suite at app.init, unlike Redis which stays
  optional.
- **Redis in e2e**: the compose Redis is shared and persistent, so
  test/global-setup.ts FLUSHDBs it per run (the cache is disposable by design) —
  without that, stale `presence:*` keys from a previous run gate the fast path
  against area ids that no longer exist. presence-cache and stale-presence specs
  REQUIRE a live Redis (they assert keys); redis-down points its own app at a
  closed port and must stay green with or without the container. For the
  "container actually stopped" proof: `docker stop geofence-redis`, then
  `npm run test:e2e -- --testPathIgnorePatterns "presence-cache|stale-presence"`,
  then `docker start geofence-redis`.
- **Known once-seen flake (Phase 4A, never reproduced across 4+ runs):** one
  full-suite failure right after that coordinate fix, detail lost. Standing
  suspect is cross-suite parallelism on the shared DB; known mitigation is
  `npm run test:e2e -- --runInBand`. If an intermittent e2e failure appears,
  suspect parallel-spec interference before anything else.

## The full green chain

A change is green when ALL of these pass, in this order:

```bash
npm run build        # nest build + tsc-alias (prod path-alias rewrite)
npm run lint         # type-checked ESLint; ~6 s warm, ~13 s cold (re-measured after the repo left OneDrive; was ~60 s there)
npm test
npm run test:e2e     # needs compose up + healthy
docker compose ps    # postgres, redis, rabbitmq all "(healthy)"; mq-topology "Exited (0)"
```

For config/bootstrap changes, additionally boot the real artifact:
`npm run start:prod` and curl `/health` — dev mode resolves path aliases
differently than `node dist/main`, so only the prod boot proves the build output.

## The stale-dev-server trap (this actually happened here)

Symptom observed in this repo: `start:prod` failed with `EADDRINUSE` on :3000,
yet `curl /health` returned 200 — with a response shape matching **old code**. A
dev server from an earlier session had survived its task stop (Windows kills the
npm wrapper, not the child node process) and was still serving on 3000. The curl
"pass" was a false pass against stale code.

Rules that follow:

1. **Before trusting any curl against localhost, know which process owns the
   port**: `netstat -ano | grep ":3000" | grep LISTENING`, then kill a stale PID
   with `Stop-Process -Id <pid> -Force` (PowerShell).
2. A response that doesn't match the code you just wrote is evidence of a stale
   server, not evidence your change "didn't work" — check the port owner before
   debugging the code.
3. After stopping a background `npm run start:dev` task, verify the port is
   actually free — the stop is not proof on Windows. **And freeing the port is
   not the end of it** (migration audit, 2026-08-07): killing the watch *child*
   leaves the `nest start --watch` *wrapper* alive, and any later file change
   makes it rebuild and **respawn the old server mid-session** — this
   contaminated a verification (curls answered by the wrong directory's build)
   and was caught only by re-checking the port owner's command line. Kill the
   wrapper too (`Get-CimInstance Win32_Process | Where CommandLine -match
   'nest.js. start'`), and re-verify the port owner before every HTTP
   conclusion, not just after the kill.

Related port trap: this machine also runs a native PostgreSQL on 5432, so `.env`
here uses `POSTGRES_PORT=5433`. A DB auth failure with correct credentials means
you may be talking to the wrong server entirely.

## Never trust wall-clock through `docker exec`

`docker exec` costs **3.5–8 s of startup** on this machine, and it inverted an
experimental conclusion once (Phase 3, 2026-08-07): the naive lock fold appeared
to block correctly under `time docker exec psql …` — the "blocking" was exec
startup — until server-side timing exposed a plan that skipped the lock entirely
(`Function Scan on pg_advisory_xact_lock … never executed`). Rule: timing
evidence comes from instruments that measure inside or alongside the server —
`EXPLAIN ANALYZE` (Execution Time includes lock waits), psql `\timing` within a
session, or in-process `hrtime` in a Node script. Wall-clock around `docker exec`
is startup noise wearing a result's clothes.
