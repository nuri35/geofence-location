---
name: nest-conventions
description: Use when adding or changing any NestJS building block in this repo — module, controller, provider, DTO, filter, interceptor, decorator — or any code that needs configuration values. Codifies the config-access rule, the response envelope and its escape hatch, and the lint rules that have actually failed builds here.
---

# NestJS conventions as practiced in this repo

Grounded in the actual source at the cited paths. NestJS 11.1.28, Express 5,
TypeScript 5.9 strict (verified via `npm ls` and tsconfig).

## Layout and boundaries

```
src/config/     the ONLY place allowed to read process.env (see below)
src/common/     cross-cutting: filters/, interceptors/, decorators/, dto/ — each with an index.ts barrel
src/health/     GET /health (Terminus) — pattern for a feature module: *.module.ts + *.controller.ts + *.constants.ts
src/migrations/ TypeORM migrations (see typeorm-migrations skill)
```

Feature modules own their constants file (`health.constants.ts`,
`areas.constants.ts`, `locations.constants.ts`). No magic strings: string-y
identifiers live in enums or exported constants — existing ones are
`ConfigNamespace`, `EnvKey`, `NodeEnvironment` (src/config/config.constants.ts),
`SWAGGER_PATH` (src/main.ts), `HEALTH_INDICATOR_DATABASE`, and
`SKIP_RESPONSE_TRANSFORM_KEY`. (A `src/redis/` module with a `REDIS_CLIENT`
Symbol existed as the external-client wrapper pattern until the presence cache
was removed — ADR 0007; see git history if that pattern is needed again.)

## The config rule (enforced by convention — check it in review)

**Nothing outside `src/config/` touches `process.env`.** Verify with
`grep -rn "process.env" src/ --include="*.ts"` — every hit must be under
`src/config/`. Consumers get config three ways:

1. Inject a namespace into a factory: `inject: [databaseConfig.KEY]` with
   `(db: ConfigType<typeof databaseConfig>) => …` — see `TypeOrmModule.forRootAsync`
   in src/app.module.ts.
2. `configService.getOrThrow<AppConfig>(ConfigNamespace.App)` — see src/main.ts.
3. New env vars: add to `EnvKey`, to the Joi schema in src/config/env.validation.ts,
   to `.env.example` (documented), and to the README env table. **Required vars get
   `.required()` and NO default** — infra coordinates (all `POSTGRES_*`) must never
   be guessed. Missing → boot aborts with
   `Config validation error: "POSTGRES_PASSWORD" is required` (verified by removing
   the var and booting). Only genuinely optional vars (`NODE_ENV`, `PORT`) carry
   defaults. In factories, read required vars via
   `requireEnv(EnvKey.X)` (src/config/env.util.ts) — it treats `''` as missing,
   matching Joi.

## Response envelope and its escape hatch

`ResponseTransformInterceptor` is registered globally via `APP_INTERCEPTOR` in
src/app.module.ts and wraps every controller response as
`{ statusCode, timestamp, data }`. Two things it does NOT touch:

- Routes decorated with `@SkipResponseTransform()` (class or method level) — read
  via `Reflector.getAllAndOverride(SKIP_RESPONSE_TRANSFORM_KEY, [handler, class])`.
  `HealthController` uses it because monitors/probes depend on the raw Terminus
  shape; any future endpoint with an external contract (webhooks, metrics) gets the
  same decorator, never a path check inside the interceptor.
- `/docs` — Swagger is served by middleware, so interceptors never applied to it.

`AllExceptionsFilter` (global via `APP_FILTER`, `@Catch()` catch-all — replaced
the old HttpException-only filter in Phase 4B after the smoke test caught two
inconsistent failure shapes) shapes every error as
`{ statusCode, timestamp, path, message }`. Its branches: (1) an `HttpException`
carrying a structured object payload **without** a `message` key passes through
verbatim — that keeps Terminus's per-indicator detail in unhealthy `/health`
503s; (2) other `HttpException`s get the house shape, `message` passing
class-validator's `string[]` untouched; (3) exposed 4xx middleware errors
(http-errors convention, e.g. body-parser's 413) get the house shape with their
own message; (4) anything else is internal — client sees the generic
`"Internal server error"`, the log gets message + stack. Never let a raw driver
message reach a response. Contract pinned by test/errors.e2e-spec.ts.

## DTO validation

The global `ValidationPipe` is provided as `APP_PIPE` in src/app.module.ts (moved
from main.ts in Phase 2A so e2e harnesses get the exact production pipe) and runs
with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`. Consequences for every DTO you
write: a request field without a decorated DTO property is a **400, not silently
stripped**; DTO instances are real class instances (`transform`), so
`@Type(() => Number)` etc. work. `src/common/dto/` holds the shared documentation
DTOs: `ResponseEnvelopeDto` and `ErrorResponseDto` — used by the
`ApiEnvelopedResponse` decorator (src/common/decorators/) so /docs shows the
envelope the wire actually carries; the schema is pinned by
test/openapi.e2e-spec.ts.

## Path aliases

`@app/*` → `src/*`, `@config/*` → `src/config/*` (tsconfig paths). They work in
`nest start`, Jest (`moduleNameMapper` in package.json + test/jest-e2e.json), and
production builds — `npm run build` runs `tsc-alias` after `nest build` to rewrite
them in dist/ (verified: `dist/app.module.js` contains `require("./common/filters")`).
Convention: aliases for cross-folder imports, relative paths within a folder
(e.g. `../decorators` inside common/). If you change the build script, re-verify
with `node dist/main` — plain tsc does NOT rewrite paths.

## Lint rules that have actually broken this build

ESLint 9 flat config (eslint.config.mjs), type-checked, with four explicit rules.
Real failures fixed in this repo — write code that avoids them upfront:

- `explicit-function-return-type` fires on **inline arrows**, including Terminus
  indicator callbacks and test mocks. Fix pattern:
  `(): Promise<HealthIndicatorResult> => this.db.pingCheck(...)`.
- `no-unsafe-member-access` fires on `SomeClass.prototype.x` because `prototype`
  is `any` on a bare constructor type — declare an interface with a typed
  `prototype` (see response-transform.interceptor.spec.ts).
- `require-await` (from recommendedTypeChecked) rejects `async` methods with no
  `await` — a deliberately-empty lifecycle method returns `Promise.resolve()`
  instead (see the migration `down()` in src/migrations/).
- `tsconfig` has `noUnusedLocals`/`noUnusedParameters` — omit unused params
  entirely (interfaces are structural; implementing with fewer params is fine).

Lint cost: ~6 s warm, up to ~60 s cold on this machine (measured) — run it per
change-set, not per file.
