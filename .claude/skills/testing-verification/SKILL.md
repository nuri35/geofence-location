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
- The full suite runs under any presence-read strategy via
  `PRESENCE_READ_STRATEGY` (default: folded, ADR 0007). The Redis-down
  verification is `docker compose stop redis` + the locations/areas suites under
  the cache strategy — real container stop, not mocks. Known nuisance: with Redis
  down, Jest may warn "worker failed to exit gracefully" (ioredis reconnect-timer
  race at teardown); flaky, cosmetic, does not affect results.

## The full green chain

A change is green when ALL of these pass, in this order:

```bash
npm run build        # nest build + tsc-alias (prod path-alias rewrite)
npm run lint         # type-checked ESLint; ~6 s warm, ~13 s cold (re-measured after the repo left OneDrive; was ~60 s there)
npm test
npm run test:e2e     # needs compose up + healthy
docker compose ps    # both containers "(healthy)"
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
   actually free — the stop is not proof on Windows.

Related port trap: this machine also runs a native PostgreSQL on 5432, so `.env`
here uses `POSTGRES_PORT=5433`. A DB auth failure with correct credentials means
you may be talking to the wrong server entirely.
