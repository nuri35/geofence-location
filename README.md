# geofence-location

A geofencing API built on NestJS + PostgreSQL/PostGIS. Users report coordinates
(`POST /locations`); when a user **enters** a predefined geographic area, exactly one
event is logged with user, area, and timestamp — under high concurrent load, without
duplicates. Areas are managed as GeoJSON polygons (`POST /areas`, `GET /areas`); the
entry log is queryable via `GET /logs` (keyset-paginated). How the system behaves
under load — the case's central requirement — is answered in
[one place below](#under-load--concurrency-capacity-degradation).

Decisions and project state live in [CLAUDE.md](CLAUDE.md); reasoning lives in
[docs/ADR/](docs/ADR/README.md); working conventions live in [.claude/](.claude/README.md).

## The target architecture — where this is heading

> **None of this section is built yet.** It is the recorded direction
> ([ADR 0011](docs/ADR/0011-partitioned-async-architecture.md)), being built in
> phases N2–N6; everything after this section describes the synchronous system
> that exists and runs today.

```
  mobile client — adaptive sending: ≥10 s since last send, ≥50 m moved, usable accuracy
        │
        │  POST /locations  { userId, deviceId, seq, lat, lng, capturedAt, accuracy }
        ▼
  stateless API ──── validate, stamp receivedAt ────────────────►  202 Accepted
        │                                                          (no DB touch,
        │  publish                                                  no transition result)
        ▼
  partitioned queue — FIXED 256 partitions, key = hash(userId)
        │              same user → same partition → per-user order preserved
        ▼
  worker — owns SEVERAL partitions (worker count independent of partition count)
        │    one user's events in order; different users in parallel
        │
        │  1. dedup (deviceId, seq)
        │  2. point-in-polygon from IN-MEMORY versioned polygon snapshot
        │  3. previous membership: Redis → Postgres, lazily
        ▼
  ┌─────────────────────  AREA CHANGED?  ─────────────────────┐
  │                                                           │
  │  NO  (~99% of traffic)                YES  (~1%)          │
  ▼                                       ▼                   │
  acknowledge.                            ENTER / EXIT event  │
  No write. No database.                  ONE Postgres txn:   │
  Nothing happens — by design.            advisory lock,      │
                                          re-verify presence, │
                                          ON CONFLICT arbiter,│
                                          presence + log      │
                                          ▼                   │
                                          ack AFTER commit    │
                                          (worker dies ⇒      │
                                           redelivery, clean) │
  └───────────────────────────────────────────────────────────┘

  POST /areas ──► Postgres (source of truth + ST_IsValid) ──► bump area version
                 ──► publish invalidation ──► workers reload snapshot
                     (periodic version polling self-heals a missed notification)
```

**Why this shape.** Each layer scales with a different thing: the API with
instances (it holds no state and touches no database), the queue with its fixed
partition count (256 partitions serve a million users — same user, same lane),
workers with load (ownership rebalances; a slow user delays only their own
lane), and Postgres with **membership changes only** — the ~1% of events on the
right branch of the fork. That fork is the design: the shared resource every
per-ping round trip used to consume (Postgres connections, PostGIS execution)
leaves the per-event path entirely, and the queue absorbs bursts that the
synchronous system can only shed with 503s. The database remains the source of
truth and the final arbiter — the advisory lock and `ON CONFLICT` survive
unchanged inside the 1% path, because a rebalance window can briefly hand one
partition to two workers and the message layer's ordering promise is not a
correctness foundation.

## Architecture as built today — the five-minute version

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

**Point-in-polygon runs in memory since Phase N2** ([ADR 0012](docs/ADR/0012-in-memory-spatial-index.md)):
each instance holds every polygon in an rbush-indexed snapshot loaded from
Postgres at startup and answers "which areas cover this point" without touching
the database — reproducing `ST_Covers` semantics exactly (the boundary line
counts as inside, [ADR 0003](docs/ADR/0003-spatial-query-strategy.md); proven by
an equivalence harness that runs ~840 boundary-hostile points through both
engines and is kept as a permanent test). A singleton `area_version` counter is
bumped in the same transaction as every `POST /areas`; the creating instance
refreshes its snapshot before responding, other instances poll every 30 s.
PostGIS remains the source of truth for geometry: polygons are validated
structurally at the DTO layer and geometrically with `ST_IsValid` before any row
is stored, plus a database `CHECK` constraint as backstop, and the GIST index
stays for the validator-side query.

**The ~99% no-change request touches no database at all since Phase N3**
([ADR 0013](docs/ADR/0013-presence-cache-no-change-fast-path.md)): previous
membership is read from a Redis cache **without the lock and without a
transaction**; if nothing changed, the request is acknowledged right there —
point-in-polygon in memory (N2), presence from Redis, zero Postgres. Only a
membership change opens the transaction, where presence is **re-read
authoritatively under the advisory lock** and the diff recomputed before any
write — the cache answers "do I need to write?", Postgres always answers "what
do I write?". Keys are DELed after commit (never updated) and every cached value
carries a TTL that bounds the one dangerous staleness direction; that exposure
was deliberately provoked and measured, not argued
(`test/stale-presence.e2e-spec.ts`). Correctness never depends on Redis: with
the container stopped, every path falls through to Postgres and the full
acceptance suite stays green (scenario 10, un-retired). The history of how the
presence read got here — including the first cache that was built, measured,
and removed — lives in the load section below.

## Under load — concurrency, capacity, degradation

The case requires the system to "perform well under load and be capable of handling a
large number of concurrent requests." That sentence contains two different problems —
being *correct* when requests race, and having *capacity* when they pile up — plus a
third the requirement implies: degrading in a bounded way when capacity runs out.
This section answers all three, with numbers, **for the synchronous system as built
today** — these measurements are the baseline the target architecture (above) starts
from, and they remain the honest description of what currently runs. Every number
below was measured on one development box (Windows/WSL2 Docker, generator + app +
Postgres co-located, same-host database, warm connection pool) via closed-loop load
against the real production artifact — 10,000 distinct users, four concurrency
levels, two workload shapes; full method in
[docs/PRESENCE_READ_MEASUREMENT.md](docs/PRESENCE_READ_MEASUREMENT.md). The system
has **not** been run at 10,000 req/s, and nothing here implies otherwise.

### 1. Correctness under concurrency

Concurrent requests produce correct results because the deciding step lives in
Postgres, not in application memory: the per-user advisory lock serializes one
user's requests, `INSERT … ON CONFLICT DO NOTHING … RETURNING` is the arbiter of
whether an entry log is written, and both sit in one transaction — state and log
commit atomically or not at all. Measured, not asserted: twenty simultaneous
identical requests produce exactly one log row (e2e, every run), and ten parallel
requests fired by hand during the smoke test produced exactly one non-empty
response and exactly the right rows.

This property matters more than it looks, because **it is what makes horizontal
scaling possible at all**. Nothing in the correctness path assumes a single
process: two instances, or twenty, racing on the same user resolve identically,
because the database arbitrates. The designs that would have broken here — an
in-process cache, or Redis holding the presence state — were considered and
rejected precisely on this ground ([ADR 0002](docs/ADR/0002-presence-table-source-of-truth.md)
records the four failure modes of Redis-as-truth).

### 2. Capacity

One Node process sustains **~1,600 req/s** on the reference box, with clean tails
(p99 11 ms at 10 in-flight, 353 ms at 500) and zero errors. The bottleneck is the
**Node event loop, not the database**: a bare 404 route on the same box ceilings at
~5,500 req/s, and at full load the 10-connection pool sat with fewer than 2
connections active — Postgres was mostly waiting for Node, not the reverse
(connection demand ≈ 6.4 of 10).

The scaling path is therefore horizontal, and the architecture already supports it
(section 1 is the proof obligation, and it's discharged in the database). Its limit
is arithmetic against Postgres: `N instances × pool size ≤ max_connections −
~10 reserved`. Concretely, at the default pool of 10 and the container's default
`max_connections = 100`: **8 × 10 = 80 fits; 12 × 10 = 120 does not** — at that
point the per-instance pool shrinks (per-instance demand falls as N grows, so the
formula self-corrects) or PgBouncer enters. Pool sizing is env-configurable and
ordering-validated for exactly this moment ([ADR 0009](docs/ADR/0009-connection-and-query-bounds.md)).

### 3. Degradation

Bounds exist so no single request can hold the system hostage: pool acquire **2 s**,
statement ceiling **5 s** (bounds advisory-lock convoys — measured firing inside the
lock function), idle-in-transaction kill **10 s**, all ordering-enforced at boot,
all returning **503 + `Retry-After: 5`** instead of joining an invisible queue
([ADR 0009](docs/ADR/0009-connection-and-query-bounds.md)). The point worth stating
plainly: the load measurement's "zero errors at every level" was **not a good
sign** — with no acquire timeout, an exhausted pool made requests wait forever, and
a probe proved it (silent indefinite wait unbounded; clean rejection at 1.5 s
bounded). The old behaviour was an unbounded queue wearing a flattering costume;
the bounds convert it into visible, sheddable, retryable load. Retrying is safe by
construction: `ON CONFLICT` absorbs duplicate entries, and a timed-out location
report self-heals on the user's next ping.

### The optimisation record — measured, including the losers

Nothing here was added because it sounded fast. What was tried:

- **GIST index on the polygon column** — measured (index-rewritten containment
  plan), kept. [ADR 0003](docs/ADR/0003-spatial-query-strategy.md)
- **`(recorded_at DESC, id DESC)` index for the log walk** — added on evidence: the
  unfiltered page was a 41 ms seq scan at 200k rows, 0.34 ms after.
  [ADR 0006](docs/ADR/0006-read-endpoint-pagination.md)
- **`folded` PL/pgSQL lock-and-read** — 4 round trips instead of 5, **+15–20%
  throughput** over the two-step baseline in both workloads at every concurrency
  level (1,605 vs 1,393 req/s static at c=500), raced against two alternatives.
  [ADR 0007](docs/ADR/0007-presence-read-strategy.md)
- **Redis presence cache** — built, measured, **removed**: +7% on a static workload
  at 99.7% hit rate, −13 to −18% *below baseline* under transitions as invalidation
  churn collapsed the hit rate to 0.50–0.78; review also found a correctness hole.
  The bottleneck was never the database read. [ADR 0007](docs/ADR/0007-presence-read-strategy.md)
- **Queue for log writes** — rejected on arithmetic: ~8 persistent inserts/s
  average, ~170/s worst peak; both trivial for Postgres.
  [ADR 0004](docs/ADR/0004-no-queue.md)
- **Pool enlargement** — rejected on measurement: demand ≈ 6.4 of 10 connections,
  mostly idle-in-transaction; more connections change nothing while Node is the
  wall. [ADR 0009](docs/ADR/0009-connection-and-query-bounds.md)
- **In-memory spatial index (Phase N2)** — built after its equivalence proof
  (zero mismatches vs `ST_Covers` over ~840 boundary-hostile probes), measured
  with same-session ABBA bracketing after run-to-run machine drift (±15–20%)
  was caught inflating single comparisons: **+6–24% on the no-change workload,
  positive in all eight adjacent comparisons; no attributable effect on
  transitions** (they are dominated by the write transaction). The stub's
  +43–50% projection was an upper bound and behaved like one. Costs priced:
  8 ms startup at 2 areas, 192 ms and ~49 MB per instance at 10k areas.
  [ADR 0012](docs/ADR/0012-in-memory-spatial-index.md)
- **Redis presence cache, second attempt (Phase N3)** — the first attempt lost
  under cache-under-lock and was removed (above); moved OUTSIDE the lock with a
  no-change fast path that skips the transaction entirely, it won decisively
  where it matters: **static +56–104% under ABBA bracketing (≈2.9k → ≈5.1k
  req/s, Postgres untouched — the request is HTTP + one Redis GET, at the
  measured bare-route Node ceiling)**; transition −8 to −28%, the cache's
  worst-case workload, accepted deliberately for the ~99% no-change traffic
  shape. The stale-key suppression ADR 0007 identified is now bounded by a TTL
  and was provoked in a test rather than reasoned away.
  [ADR 0013](docs/ADR/0013-presence-cache-no-change-fast-path.md)

### Two optimisations that were deferred — and how each resolved

Both were recorded as decisions with revisit conditions; the target architecture
resolved both:

- **Polygon caching** — the revisit condition *fired*, and the resolution is now
  **built**: the pre-registered stub experiment priced the round trip's removal
  at +43–50% (ADR 0003 annotations), phase N2 then delivered the in-memory
  versioned snapshot and collected **+6–24% on the static workload** under
  stricter ABBA bracketing — the optimisation record entry above has the honest
  comparison, [ADR 0012](docs/ADR/0012-in-memory-spatial-index.md) the full
  matrix.
- **Collapsing the request into one round trip** — *dissolved rather than
  built*: the worker model removes the per-ping round trips wholesale, which is
  what the PL/pgSQL fold was for. The analysis stays in git history; no revisit
  condition remains.

## The adaptive client contract (design assumption, ADR 0010)

The scaling story assumes clients send **adaptively, not on a timer**: a location
event is worth sending when **(1)** at least ~10 seconds have passed since the last
send, **(2)** the device has moved at least ~50 metres, and **(3)** the GPS fix is
accurate enough to trust. This matters because event volume then scales with
*movement*, not with population × clock — a fixed-interval client multiplies load
without adding information, and the downstream design (dedup, and the queue-based
architecture this contract prepares for) is sized around the adaptive assumption.

The logic lives on the device; the server records the assumption and defends
against bad input: readings with `accuracy` > 100 m are rejected with **422** (an
error radius that large cannot answer "inside or outside" near any boundary), and
retried events are absorbed by per-device deduplication (`deviceId` + `seq`, where
`seq` detects repeats — it is **not** an ordering guarantee). Clients that predate
the contract send neither field and are processed without deduplication.

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
| `POST /locations` | Report a position; returns 201 `{ enteredAreaIds: [...], duplicate: false }` — the entries this request produced. Optional `deviceId`+`seq` enable per-device dedup (repeats → 200, `duplicate: true`); `accuracy` > 100 m → 422; `capturedAt` stored, informational (ADR 0010) |
| `POST /areas` | Create an area from a GeoJSON Polygon (`[lng, lat]` order; ≤1000 vertices; `ST_IsValid`-gated with the reason in the 400) |
| `GET /areas` | List areas with full GeoJSON geometry, `limit`/`offset` |
| `GET /logs` | Entry log, newest first, keyset-paginated over `(recorded_at, id)` via an opaque cursor (`nextCursor`, null at the end); optional combinable filters `userId`, `areaId`, `from`/`to` on `recorded_at`; page size 50, max 500 |
| `GET /metrics` | Internal, per-instance, reset-on-restart counters for the presence-cache staleness exposure (ADR 0013 addendum): failed invalidations qualified by GET health, and hint-opened no-op transactions — the latter is an UPPER BOUND on suppressed entries, not a count |

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
| `AREAS_POLL_INTERVAL_MS` | no | `30000`  | How often each instance polls `area_version` for polygon changes made by other instances; the creating instance refreshes immediately (ADR 0012) |
| `REDIS_HOST`        | yes      | —             | Redis host (presence cache — ADR 0013). Correctness survives the server being DOWN; the coordinates are still never guessed |
| `REDIS_PORT`        | yes      | —             | Redis port (also used by compose mapping) |
| `REDIS_PASSWORD`    | no       | *(empty)*     | Redis AUTH password; empty = no auth (compose default) |
| `PRESENCE_CACHE_TTL_NONEMPTY_S` | no | `15`     | Staleness bound for cached NON-EMPTY membership — the entry-killing direction; worst-case entry suppression equals this (ADR 0013 addendum) |
| `PRESENCE_CACHE_TTL_EMPTY_S` | no | `300`       | Staleness bound for the cached empty set `"[]"` — the safe direction: heals on the next inside ping, can only merge visits |

The three timeouts are ordering-validated at boot — a misordered combination refuses
to start. The migration CLI deliberately carries none of these bounds.
