# CLAUDE.md — project constitution

Decisions and project state only. Conventions ("how") live in `.claude/skills/`;
tooling onboarding lives in `.claude/README.md`; reasoning lives in `docs/ADR/`.
If a section here grows past a few lines, it belongs in an ADR.

## Project

Geofencing API: NestJS + TypeScript + PostgreSQL/PostGIS, Redis as cache. Four
endpoints — `POST /locations`, `GET /logs`, `POST /areas`, `GET /areas`. Users
report coordinates at intervals; when a user **enters** a predefined geographic
area, exactly one event is logged (user ID, area ID, timestamp). Entry is a
transition, not a state — a user sitting inside an area for ten minutes produces
one log, not sixty — and the system must hold under high concurrent load
(~1,000 req/s assumed). This is a 3-day technical case; the timebox is why the
scope is drawn where it is (see Non-goals and [docs/SCOPE.md](docs/SCOPE.md)).

## Non-goals

Deliberate omissions, not oversights — each expanded with its cost and remedy in
[docs/SCOPE.md](docs/SCOPE.md):

- **Authentication / user identity trust** — user IDs are accepted as claimed; identity is orthogonal to the geofencing problem under assessment.
- **Exit event logging** — the spec demands entries only; unlogged exits are unreconstructible later, and that cost is accepted knowingly.
- **GPS jitter hysteresis / debounce** — boundary oscillation produces repeated *genuine* entries; a dwell/buffer rule is a product decision outside the timebox.
- **Request idempotency keys** — the transition model absorbs most duplicate deliveries; full at-least-once protection is not attempted.
- **Out-of-order sample protection** — arrival order is processing order; a sample delayed in transit is treated as current. The real fix is client sequence numbers, out of scope without a real client.
- **Log retention / partitioning** — irrelevant at case scale; a real deployment accumulates ~700k rows/day and must partition.
- **Area update/delete semantics for users already inside** — creating, editing, or deleting an area over a stationary user has undefined entry semantics; frozen out of scope rather than half-decided.
- **Rate limiting** — a misbehaving client can multiply its load share; deferred with the rest of the abuse surface.
- **Antimeridian / pole-crossing polygons** — planar SRID 4326 math silently misinterprets polygons spanning ±180°; city-scale areas make this irrelevant here.

## Reading order

Start with the lookup table in [.claude/README.md](.claude/README.md)
("I am about to X → read this first"). Rows added by this phase:

| About to… | Read |
| --- | --- |
| Touch presence, transition, or logging logic | [ADR 0002](docs/ADR/0002-presence-table-source-of-truth.md) |
| Write or tune a spatial query | [ADR 0003](docs/ADR/0003-spatial-query-strategy.md) + `.claude/skills/postgis-spatial` |
| Add async infrastructure (queue, worker) | [ADR 0004](docs/ADR/0004-no-queue.md) |
| Touch timestamps, ordering, or `observed_at` | [ADR 0005](docs/ADR/0005-time-and-ordering-policy.md) |
| Design or change a read endpoint's paging or filters | [ADR 0006](docs/ADR/0006-read-endpoint-pagination.md) |
| Implement (or cut) anything near a non-goal | [docs/SCOPE.md](docs/SCOPE.md) |
| Write tests for core behaviour | [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) |

## Decisions

Numbered, append-only. One or two sentences here; the reasoning lives in the ADR.

1. Point-in-polygon runs in PostgreSQL via PostGIS with a GIST index on the polygon column; polygons are not loaded into the application layer. — [ADR 0003](docs/ADR/0003-spatial-query-strategy.md)
2. `ST_Covers`, not `ST_Contains`: the boundary line counts as inside. — [ADR 0003](docs/ADR/0003-spatial-query-strategy.md)
3. `user_area_presence(user_id, area_id)` in PostgreSQL, composite primary key, is the source of truth for current membership. — [ADR 0002](docs/ADR/0002-presence-table-source-of-truth.md)
4. Presence rows and log rows are written in one transaction; a log is emitted only when `INSERT … ON CONFLICT DO NOTHING … RETURNING` actually returns a row. Departures are the other half: the presence row is deleted and nothing is logged — without the delete, exit-and-re-enter cannot work at all. — [ADR 0002](docs/ADR/0002-presence-table-source-of-truth.md)
5. A user may be inside multiple overlapping areas simultaneously; a transition is a set difference, not a single value. — [ADR 0002](docs/ADR/0002-presence-table-source-of-truth.md)
6. Redis is a read-through cache in front of presence — lazy loading, negative caching as a JSON string value (`"[]"` = known-empty, key absent = not cached), invalidated after commit rather than updated. Losing Redis costs latency, never correctness. — [ADR 0002](docs/ADR/0002-presence-table-source-of-truth.md)
7. No queue: persistent log inserts are rare (~8/s average, ~170/s worst peak) and connection pool sizing covers spikes. — [ADR 0004](docs/ADR/0004-no-queue.md)
8. `recorded_at` (server receive time) is authoritative for both ordering and the logged time. `observed_at` (client-reported, nullable) is stored on log rows only, for informational purposes, and participates in no logic — no rejection, no comparison, no state; there is no samples table, and a request that produces no entry stores nothing. — [ADR 0005](docs/ADR/0005-time-and-ordering-policy.md)
9. First observation of a user already inside an area is recorded as an entry — an accepted assumption, not an observed transition. — [ADR 0002](docs/ADR/0002-presence-table-source-of-truth.md)
10. Concurrent requests for the same user are serialized by `pg_advisory_xact_lock(hashtext(user_id))` as the first statement of the write transaction; `ON CONFLICT` stays as the correctness backstop. — [ADR 0002](docs/ADR/0002-presence-table-source-of-truth.md)
11. `POST /locations` returns 201 with a body naming the entries it produced — `{ enteredAreaIds: [...] }`, empty array when nothing happened — delivered inside the standard response envelope (`nest-conventions`).
12. `GET /logs` uses keyset pagination with a cursor over `(recorded_at, id)` and filters `userId`, `areaId`, `from`, `to`; offset pagination is rejected because it skips and duplicates rows under concurrent inserts on an append-only table. — [ADR 0006](docs/ADR/0006-read-endpoint-pagination.md)
13. `GET /areas` returns full geometry as GeoJSON with plain `limit`/`offset` — acceptable because the table is small and nearly static; the two read endpoints differ by decision, not accident. — [ADR 0006](docs/ADR/0006-read-endpoint-pagination.md)
14. `user_id` is `varchar(64)` — free-form, since auth is a non-goal (identity is a claim, not a verified fact), but bounded so the column and the advisory-lock hash have a defined input.

## Hard constraints

Prohibitions. Breaking one is a bug even if everything is green.

- Never `synchronize: true` or `migrationsRun: true`; schema changes go through migrations only, and an executed migration is never edited — fix forward. (`typeorm-migrations`)
- Nothing outside `src/config/` reads `process.env`. (`nest-conventions`)
- Spatial parameters never go through TypeORM `.where()` object syntax — TypeORM does not transform them; write raw SQL with explicit `ST_*` calls and `ST_SetSRID(…, 4326)`. (`postgis-spatial` §4)
- SRID 4326 is declared in all three places: column type modifier, insert, query parameter. (`postgis-spatial` §3)
- No polygon is stored without passing `ST_IsValid`; the 400 response carries `ST_IsValidReason`. Never auto-repair user input with `ST_MakeValid`. (`postgis-spatial` §7)
- No polygon with more than 1000 vertices is accepted — enforced at the DTO layer with a clear 400.
- Presence and log writes never happen outside a single transaction. (Decision 4)
- Redis is never consulted to decide what gets logged, and never written before the owning transaction commits. (Decision 6)
- No localhost HTTP verification is trusted without first checking which process owns the port. (`testing-verification`)

## Phase status

The single source of truth for progress — phase documents carry no status field.

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Architecture decisions, scope, acceptance criteria | Complete |
| 1 | Areas: table + migration + GIST index, `POST`/`GET /areas`, `ST_IsValid` gating, vertex cap; point-in-polygon query proven in isolation with `EXPLAIN ANALYZE` on the real query shape | Complete |
| 2 | Core (must not be cut): logs + `user_area_presence` tables, full `POST /locations` transition path — transaction + advisory lock + `ON CONFLICT` + exit-side deletion; every acceptance scenario becomes a test | In progress — 2A (schema + entities + APP_PIPE) done; 2B (transition path) pending |
| 3 | Redis read-through cache in front of presence + Redis health indicator. Explicitly cuttable — the architecture is correct without it | Not started |
| 4 | `GET /logs` keyset pagination + its indexes, pool sizing, `statement_timeout`, load measurement with real numbers | Not started |
| 5 | README, Swagger, full green chain, manual audit of every acceptance scenario, clean-clone verification | Not started |

## Session protocol

- **Start**: read this file. Read `.claude/README.md` once ever. `docker compose up -d`, wait for both containers `(healthy)`.
- **Before any commit**: the full green chain per `.claude/skills/testing-verification` — build, lint, test, test:e2e, compose healthy; plus a prod boot (`node dist/main` + `/health`) for config or bootstrap changes.
- **A new ADR is required** when a decision constrains future work or rejects an obvious alternative — the bar set by ADR 0001. Number sequentially; add a row to [docs/ADR/README.md](docs/ADR/README.md).
- **Session end**: update the phase table above; append decisions (never rewrite); anything half-decided becomes an explicit open question, not silent scope.
