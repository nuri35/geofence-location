# CLAUDE.md — project constitution

Decisions and project state only. Conventions ("how") live in `.claude/skills/`;
tooling onboarding lives in `.claude/README.md`; reasoning lives in `docs/ADR/`.
If a section here grows past a few lines, it belongs in an ADR.

## Project

Geofencing system: a stateless NestJS API that validates, stamps `receivedAt`,
and publishes location events to a consistent-hash-partitioned RabbitMQ
topology (202 `{eventId}`, eventually consistent); a separate worker process
that owns partitions statically and runs the transition path — in-memory
polygons, worker-memory presence and dedup, one Postgres transaction per
membership change, ack after commit. PostgreSQL/PostGIS is the source of
truth; Redis is a narrow cache for the parked API-side path plus post-commit
invalidations. Endpoints: `POST /locations`, `GET /logs`, `POST /areas`,
`GET /areas`, plus `GET /health` and the internal `GET /metrics`. When a user
**enters** a predefined area, exactly one event is logged (user ID, area ID,
`recorded_at` = API receipt time). Entry is a transition, not a state — ten
minutes inside produces one log, not sixty — and per-user ordering holds
end-to-end (same user → same partition → per-user chain). Born as a 3-day
technical case (the original timebox is why the Non-goals are drawn where they
are — [docs/SCOPE.md](docs/SCOPE.md)), then extended through the phases below
into the partitioned asynchronous architecture of
[ADR 0011](docs/ADR/0011-partitioned-async-architecture.md).

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
| Touch the in-memory spatial index, snapshot polling, or `area_version` | [ADR 0012](docs/ADR/0012-in-memory-spatial-index.md) |
| Touch the presence cache, the fast path, or anything Redis | [ADR 0013](docs/ADR/0013-presence-cache-no-change-fast-path.md) |
| Touch the queue, the worker, publishing, or partitioning | [ADR 0011](docs/ADR/0011-partitioned-async-architecture.md) + [0014](docs/ADR/0014-rabbitmq-topology.md)–[0018](docs/ADR/0018-worker-local-presence.md) (ADR 0004's no-queue reasoning is superseded history) |
| Touch timestamps, ordering, or `observed_at` | [ADR 0005](docs/ADR/0005-time-and-ordering-policy.md) |
| Design or change a read endpoint's paging or filters | [ADR 0006](docs/ADR/0006-read-endpoint-pagination.md) |
| Change pool size, timeouts, or overload behaviour | [ADR 0009](docs/ADR/0009-connection-and-query-bounds.md) |
| Implement (or cut) anything near a non-goal | [docs/SCOPE.md](docs/SCOPE.md) |
| Write tests for core behaviour | [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) |

## Decisions

Numbered, append-only. One or two sentences here; the reasoning lives in the ADR.

1. Point-in-polygon runs in PostgreSQL via PostGIS with a GIST index on the polygon column; polygons are not loaded into the application layer. *(Superseded for the target by decision 22 / [ADR 0011](docs/ADR/0011-partitioned-async-architecture.md): workers hold polygons in memory; PostGIS stays source of truth and validator. Governs the synchronous system until N2.)* — [ADR 0003](docs/ADR/0003-spatial-query-strategy.md)
2. `ST_Covers`, not `ST_Contains`: the boundary line counts as inside. — [ADR 0003](docs/ADR/0003-spatial-query-strategy.md)
3. `user_area_presence(user_id, area_id)` in PostgreSQL, composite primary key, is the source of truth for current membership. — [ADR 0002](docs/ADR/0002-presence-table-source-of-truth.md)
4. Presence rows and log rows are written in one transaction; a log is emitted only when `INSERT … ON CONFLICT DO NOTHING … RETURNING` actually returns a row. Departures are the other half: the presence row is deleted and nothing is logged — without the delete, exit-and-re-enter cannot work at all. — [ADR 0002](docs/ADR/0002-presence-table-source-of-truth.md)
5. A user may be inside multiple overlapping areas simultaneously; a transition is a set difference, not a single value. — [ADR 0002](docs/ADR/0002-presence-table-source-of-truth.md)
6. *(Replaced 2026-08-07 — the original claim "losing Redis costs latency, never correctness" was falsified in review for the cache path. Superseded again 2026-08-09 by [ADR 0011](docs/ADR/0011-partitioned-async-architecture.md): Redis returns in the target as the lazy presence resolver — read outside the lock, which removes the mechanism that made it lose — and as the polygon-invalidation channel. Never as source of truth. As BUILT, both roles shrank further: the worker never reads Redis at all (decision 33), and polygon invalidation is Postgres version polling with no Redis channel (decision 25) — Redis serves the parked API path and receives post-commit DELs, nothing more.)* For the synchronous system as built: Redis is not part of it; the presence cache was built, measured, and rejected on evidence recorded in [ADR 0007](docs/ADR/0007-presence-read-strategy.md).
7. No queue: persistent log inserts are rare (~8/s average, ~170/s worst peak) and connection pool sizing covers spikes. *(Superseded by decision 20 / [ADR 0011](docs/ADR/0011-partitioned-async-architecture.md) — scope change: the arithmetic priced durable log writes, but ingestion scales with events. Governs the synchronous system until N4.)* — [ADR 0004](docs/ADR/0004-no-queue.md)
8. `recorded_at` (server receive time) is authoritative for both ordering and the logged time. `observed_at` (client-reported, nullable) is stored on log rows only, for informational purposes, and participates in no logic — no rejection, no comparison, no state; there is no samples table, and a request that produces no entry stores nothing. — [ADR 0005](docs/ADR/0005-time-and-ordering-policy.md)
9. First observation of a user already inside an area is recorded as an entry — an accepted assumption, not an observed transition. — [ADR 0002](docs/ADR/0002-presence-table-source-of-truth.md)
10. Concurrent requests for the same user are serialized by `pg_advisory_xact_lock(hashtext(user_id))` as the first statement of the write transaction; `ON CONFLICT` stays as the correctness backstop. — [ADR 0002](docs/ADR/0002-presence-table-source-of-truth.md)
11. `POST /locations` returns 201 with a body naming the entries it produced — `{ enteredAreaIds: [...] }`, empty array when nothing happened — delivered inside the standard response envelope (`nest-conventions`). *(Superseded at N4 by [ADR 0011](docs/ADR/0011-partitioned-async-architecture.md): the async API returns 202 Accepted with no transition result; clients learn of entries via `GET /logs`. This contract stands until then.)*
12. `GET /logs` uses keyset pagination with a cursor over `(recorded_at, id)` and filters `userId`, `areaId`, `from`, `to`; offset pagination is rejected because it skips and duplicates rows under concurrent inserts on an append-only table. — [ADR 0006](docs/ADR/0006-read-endpoint-pagination.md)
13. `GET /areas` returns full geometry as GeoJSON with plain `limit`/`offset` — acceptable because the table is small and nearly static; the two read endpoints differ by decision, not accident. — [ADR 0006](docs/ADR/0006-read-endpoint-pagination.md)
14. `user_id` is `varchar(64)` — free-form, since auth is a non-goal (identity is a claim, not a verified fact), but bounded so the column and the advisory-lock hash have a defined input.
15. The presence read is `folded` — lock+read in one round trip via the `lock_user_and_read_presence` plpgsql function, the only implementation. Decided by measurement (+15–20% over a two-step baseline in both workloads at every concurrency level, while a Redis cache lost to baseline under transitions); the losing paths and their strategy flag were then removed — the decision stays reversible through the ADR, the measurement doc, and git history, not through dormant code. *(Scoped to the synchronous system; as built, the worker resolves presence memory→Postgres outside the lock — decision 33 — and the folded function survives as the change path's one-round-trip authoritative read under the lock.)* — [ADR 0007](docs/ADR/0007-presence-read-strategy.md)
16. Connection and query bounds are deliberate and ordering-enforced at boot: pool acquire 2 s < statement ceiling 5 s < idle-in-transaction kill 10 s, pool size 10 per instance (explicit, env-configurable). Timeout classes return 503 with `Retry-After: 5`, never 500; the migration CLI carries no bounds. — [ADR 0009](docs/ADR/0009-connection-and-query-bounds.md)
17. GPS readings with `accuracy` above 100 m are rejected with **422** (well-formed, semantically unusable — distinct from the pipe's 400s): an error radius that large cannot answer "inside or outside" near any boundary. Absent accuracy is trusted (legacy clients). — [ADR 0010](docs/ADR/0010-adaptive-payload-contract.md)
18. Deduplication is per **(userId, deviceId)** via a monotonic `seq`, checked inside the write transaction under the advisory lock, on every request including no-ops; duplicates return 200 with `duplicate: true`, not an error. **`seq` is for dedup only — never an ordering guarantee**; ordering remains server arrival (decision 8). — [ADR 0010](docs/ADR/0010-adaptive-payload-contract.md)
19. `capturedAt` replaces `observedAt` (same semantic: device-side reading time, informational only); `observedAt` survives as a deprecated request alias, and `deviceId`/`seq` absent means legacy processing without dedup — the contract change is graceful, not breaking. — [ADR 0010](docs/ADR/0010-adaptive-payload-contract.md)
20. The target architecture is asynchronous: a stateless API stamps `receivedAt`, publishes to a partitioned queue and returns 202; workers own the transition path; the queue absorbs bursts the synchronous system could only shed. Nothing of it is built yet — phases N2–N6. — [ADR 0011](docs/ADR/0011-partitioned-async-architecture.md)
21. The queue has a FIXED partition count of 256, keyed `hash(userId)` — not a queue per user. One worker owns SEVERAL partitions; worker count and partition count are independent, ownership rebalances. Per-user order holds within a partition; a slow user delays only their own lane. — [ADR 0011](docs/ADR/0011-partitioned-async-architecture.md)
22. Workers hold the polygons in memory as a versioned snapshot and do point-in-polygon there, reproducing `ST_Covers` boundary semantics; PostGIS remains source of truth and the `POST /areas` validator. Invalidation = version bump + publish, with periodic version polling as self-healing. — [ADR 0011](docs/ADR/0011-partitioned-async-architecture.md)
23. The no-change fast exit carries the design: ~99% of events acknowledge without touching any database; only a membership change produces an ENTER/EXIT event and one Postgres transaction (advisory lock kept, presence re-verified under it, `ON CONFLICT` arbiter), acknowledged only AFTER commit so worker death means clean redelivery. Postgres write volume scales with changes, not events. — [ADR 0011](docs/ADR/0011-partitioned-async-architecture.md)
24. In the target, previous membership resolves Redis → Postgres lazily, read OUTSIDE the lock — with mandatory authoritative re-verification under the lock on the change path (the verify-on-hit ADR 0007 required). Worker-local presence state is deliberately deferred (restart loss, rebalance split-brain); Redis is never the source of truth. *(Superseded by decision 33 / [ADR 0018](docs/ADR/0018-worker-local-presence.md): static ownership un-rejected worker-local memory, and the worker's read is memory → Postgres — Redis left the worker's read path entirely. The re-verify-under-the-lock rule survives unchanged.)* — [ADR 0011](docs/ADR/0011-partitioned-async-architecture.md)
25. Point-in-polygon runs in the app tier (N2): an in-memory snapshot (rbush prefilter + turf containment, `ignoreBoundary: false`) proven equivalent to `ST_Covers` on ~840 boundary-hostile probes with zero mismatches (`test/spatial-equivalence.e2e-spec.ts`, the permanent tripwire). A singleton `area_version` row is bumped in the same transaction as the area insert; `POST /areas` refreshes the creating instance synchronously, other instances poll every 30 s (`AREAS_POLL_INTERVAL_MS`); rebuilds are serialized and swapped as one reference; a runtime rebuild failure serves stale and retries, a bootstrap failure aborts boot. PostGIS keeps truth, `ST_IsValid`, the CHECK constraint, and the GIST index. Measured (ABBA, same session): +6–24% static, no attributable transition effect. — [ADR 0012](docs/ADR/0012-in-memory-spatial-index.md)
26. Presence reads sit behind a Redis cache read WITHOUT the lock and WITHOUT a transaction (N3): an empty diff returns with nothing touched (~99%); a non-empty diff opens the unchanged ADR 0002 transaction, re-reads presence authoritatively under the lock, recomputes, writes, commits, then DELs the key. `"[]"` is a real cached value; a Redis error is not a miss (only a clean miss writes back); every populate carries a TTL (`PRESENCE_CACHE_TTL_S`, default 300 s) bounding the stale-"unchanged" suppression, which was provoked and measured, not argued. Measured (ABBA): static +56–104% (~5.1k req/s, Postgres untouched), transition −8 to −28% (the cache's worst-case workload, bought deliberately for the ~99% no-change reality). — [ADR 0013](docs/ADR/0013-presence-cache-no-change-fast-path.md)
27. Dedup (decision 18) runs only on the change path — inside the transaction, under the lock, unchanged. The fast path consults nothing: a no-change duplicate is absorbed by the transition model and returns 201 `duplicate: false`; the preserved guarantee, pinned by e2e, is that a replayed seq can never WRITE. The per-ping dedup write is retired (the direction ADR 0011 named). — [ADR 0013](docs/ADR/0013-presence-cache-no-change-fast-path.md)
28. The presence-cache TTL is differentiated by value: non-empty 15 s, `"[]"` 300 s (both env-configurable) — all of the entry-killing staleness lives in stale non-empty sets, while a stale `"[]"` heals on the next inside ping and can only merge visits (a loss class already accepted by non-goal). Two per-instance counters on `GET /metrics` make the residual exposure observable: failed DELs qualified by GET health (flap vs safe full outage) and hint-opened no-op transactions (an UPPER BOUND on suppressed entries, not a count). Fencing tokens rejected permanently; double-DEL held in reserve behind the counters; caching-only-`"[]"` open pending the dweller-share measurement. — [ADR 0013 addendum](docs/ADR/0013-presence-cache-no-change-fast-path.md)
29. The queue topology (N4A) is declared by a one-shot compose job via the management API — never by application code (a passive verify at most, from N4B on): `loc.events` (x-consistent-hash) → `loc.events.p0..N-1` quorum queues (weight 1 each) → policy-applied `delivery-limit: 5` + DLX `loc.dlx` → `loc.dead`. `MQ_PARTITION_COUNT` (8 dev / 256 prod) is effectively immutable — the declarator refuses a count mismatch; re-partitioning requires explicit manual queue deletion. Routing proven: same userId → same partition across runs; 10k users spread max/min 1.09 over 8 partitions. — [ADR 0014](docs/ADR/0014-rabbitmq-topology.md)
30. `POST /locations` publishes instead of processing (N4B): validate → accuracy gate → stamp `receivedAt` → publish (persistent, mandatory, publisher-confirmed, routing key = RAW userId) → **202 `{ eventId }`**. Decision 11's 201 contract is retired; eventual consistency is a documented API property. An unconfirmed publish is a **503 + Retry-After**, never a silent 202 — the log is the product, and the adaptive client re-sends anyway. The transition path (`LocationsService.report`) is parked off HTTP, fully covered at service level, and is what N4C mounts in the worker; between N4B and N4C the artifact accepts events and processes none (deliberate, documented interim). — [ADR 0015](docs/ADR/0015-publisher-contract.md)
31. The worker (N4C) owns partitions by STATIC configuration (`WORKER_PARTITIONS`; single-active-consumer stays unset — ownership must live in the process because N5 builds rebalancing on it), consumes via amqplib directly (Nest's RMQ transport verified against source and rejected: it declares by default, nacks with requeue=false past the delivery-limit path, and serves one queue per instance), acks ONLY after commit (fast path acks directly), passes the message's `receivedAt` as `recorded_at` — never `now()` — and dedups from a lazy in-memory Map bumped only after success (~293 B/entry measured; crash loses it, `ON CONFLICT` absorbs the duplicates; `user_event_state` is read-only until N5's checkpoints). One narrow ack-exception: FK-on-deleted-area (23503 + constraint contains `area`) is dropped, logged, counted. Prefetch 1, temporary by decision. — [ADR 0016](docs/ADR/0016-worker.md)
32. Inside a partition the worker processes users CONCURRENTLY via per-user promise chains (N5A): same user strictly sequential, different users parallel — head-of-line blocking removed (proven: users queued behind a mid-transaction head completed while it was still provably blocked). Every task acks/nacks its OWN delivery at its OWN completion; drained chains are removed with an identity-checked delete (the re-creation race resolves in the new chain's favor); shutdown cancels consumers, drains chains, then closes. Prefetch is configuration (`WORKER_PREFETCH`, default 16 — reasoned against pool size 10 and crash-redelivery burst), no longer an ordering guard. Stated consequence: a nacked message redelivered after a newer same-user message is dropped as stale by seq-dedup — arrival-order semantics, not a bug. — [ADR 0017](docs/ADR/0017-per-user-parallelism.md)
33. The worker holds presence in process memory (N5B): read order memory → Postgres — cold reads NEVER touch Redis, so a stale key cannot enter a store with no TTL (the restart-poisoning case, closed by decision); a committed transition updates memory synchronously (no await after commit — ADR 0017's rule, enforced by the service being synchronous-only and worker-only) and DELs the Redis key, never SETs it. The ADR 0013 stale-cache hazard is structurally gone from the hot path; the parked API path keeps the old shape until deleted. Measured ~287 B/user (100k ≈ 29 MB/worker); no LRU. Rebalancing must invalidate memory on partition movement — N5-final's obligation. — [ADR 0018](docs/ADR/0018-worker-local-presence.md)

## Hard constraints

Prohibitions. Breaking one is a bug even if everything is green.

- Never `synchronize: true` or `migrationsRun: true`; schema changes go through migrations only, and an executed migration is never edited — fix forward. (`typeorm-migrations`)
- Schema SQL is written by hand — `migration:generate` is disabled and refuses: two live objects (`chk_areas_boundary_valid`, `idx_logs_recorded_id`) are invisible to entity metadata and generated SQL deletes them. — [ADR 0008](docs/ADR/0008-disable-migration-generate.md)
- Nothing outside `src/config/` reads `process.env`. (`nest-conventions`)
- Spatial parameters never go through TypeORM `.where()` object syntax — TypeORM does not transform them; write raw SQL with explicit `ST_*` calls and `ST_SetSRID(…, 4326)`. (`postgis-spatial` §4)
- SRID 4326 is declared in all three places: column type modifier, insert, query parameter. (`postgis-spatial` §3)
- No polygon is stored without passing `ST_IsValid`; the 400 response carries `ST_IsValidReason`. Never auto-repair user input with `ST_MakeValid`. (`postgis-spatial` §7)
- No polygon with more than 1000 vertices is accepted — enforced at the DTO layer with a clear 400.
- Presence and log writes never happen outside a single transaction. (Decision 4)
- The presence write path never uses `repository.save()` — its upsert-by-PK semantics would silently UPDATE an existing membership and defeat the `ON CONFLICT` arbiter. Raw SQL through the transaction's manager only. (ADR 0002)
- No store other than PostgreSQL ever *decides* what gets logged. A presence hint — worker memory, the Redis cache, anything — may be read outside the lock, but any value that feeds a WRITE must be re-verified authoritatively inside the locked transaction — this is how the stale-hit hole recorded in ADR 0007 stays answered. (Decisions 6, 15, 24, 33)
- No localhost HTTP verification is trusted without first checking which process owns the port. (`testing-verification`)

## Phase status

The single source of truth for progress — phase documents carry no status field.

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Architecture decisions, scope, acceptance criteria | Complete |
| 1 | Areas: table + migration + GIST index, `POST`/`GET /areas`, `ST_IsValid` gating, vertex cap; point-in-polygon query proven in isolation with `EXPLAIN ANALYZE` on the real query shape | Complete |
| 2 | Core (must not be cut): logs + `user_area_presence` tables, full `POST /locations` transition path — transaction + advisory lock + `ON CONFLICT` + exit-side deletion; every acceptance scenario becomes a test | Complete |
| 3 | Redis read-through cache in front of presence + Redis health indicator. Explicitly cuttable — the architecture is correct without it | Complete, then reversed on evidence: cache built and measured (ADR 0007), rejected, and removed along with the Redis infrastructure |
| 4 | `GET /logs` keyset pagination + its indexes, pool sizing, `statement_timeout`, load measurement with real numbers | Complete — 4A: strategy measurement + `GET /logs`; 4B: error contract (ADR 0008-adjacent fixes), connection/query bounds (ADR 0009). Full backpressure (HTTP admission control) deliberately not built — acquire timeout is its down payment |
| 5 | README, Swagger, full green chain, manual audit of every acceptance scenario, clean-clone verification | Complete — all 14 scenarios manually audited against the prod artifact (zero contradictions), final clean clone from remote green end-to-end, Swagger reviewed (consumer gaps recorded in the phase 5 report), docs aligned |

New-architecture phases ([ADR 0011](docs/ADR/0011-partitioned-async-architecture.md) — adaptive clients → in-memory polygons → Redis presence → partitioned queue and workers):

| Phase | Scope | Status |
| --- | --- | --- |
| N1 | Adaptive payload contract: `deviceId`/`seq` dedup, `capturedAt`, `accuracy` gate — system stays synchronous | Complete — [ADR 0010](docs/ADR/0010-adaptive-payload-contract.md) |
| N2 | In-memory versioned polygon snapshot + area-version invalidation (measured upper bound +43–50%, ADR 0003 annotations) | Complete — equivalence proven (zero mismatches over ~840 probes), +6–24% static under ABBA bracketing (the stub's number was an upper bound; transition effect not attributable), costs priced at 10k areas (192 ms startup, ~49 MB/instance) — [ADR 0012](docs/ADR/0012-in-memory-spatial-index.md) |
| N3 | Redis as lazy presence resolver (read outside the lock; change-path re-verification under it) | Complete — no-change fast path skips the transaction entirely; stale-"unchanged" exposure provoked, bounded by TTL, recorded honestly; static +56–104% under ABBA (Postgres untouched on the hot path), transition −8 to −28% accepted for the ~99% no-change traffic shape — [ADR 0013](docs/ADR/0013-presence-cache-no-change-fast-path.md) |
| N4 | Partitioned queue (256, `hash(userId)`) + workers absorb the transition path; API goes 202/stateless; dedup state leaves the hot path | N4A complete — broker infrastructure: consistent-hash topology, quorum partitions, DLQ, immutable-count guard; routing proven (same user → same partition; 10k users max/min 1.09) — [ADR 0014](docs/ADR/0014-rabbitmq-topology.md). N4B complete — API publishes (202 `{eventId}`, confirms, 503 on unconfirmed publish); transition logic parked at service level for the worker — [ADR 0015](docs/ADR/0015-publisher-contract.md). N4C complete — the worker closes the loop (static partition ownership, amqplib direct, ack-after-commit, lazy in-memory dedup, receivedAt → recorded_at proven live) — [ADR 0016](docs/ADR/0016-worker.md). N4D (re-point acceptance at the async path) not started |
| N5 | Partition ownership, rebalancing, and worker parallelism hardening | N5A complete — per-user promise chains (head-of-line blocking removed, prefetch configurable) — [ADR 0017](docs/ADR/0017-per-user-parallelism.md). N5B complete — worker-local presence memory: read = memory → Postgres (never Redis on cold), commit updates memory + DELs the key; the ADR 0013 hazard structurally gone from the hot path; ~287 B/user measured — [ADR 0018](docs/ADR/0018-worker-local-presence.md). **Rebalancing/handoff/checkpointing not started** — the honest gap list is in ADR 0018's closing section |
| N6 | Load verification of the async pipeline with real numbers (the harness evolves with it) | Not started |

## Session protocol

- **Start**: read this file. Read `.claude/README.md` once ever. `docker compose up -d`, wait for the three long-running containers `(healthy)` (postgres, redis, rabbitmq); the `mq-topology` one-shot must show `Exited (0)`.
- **Before any commit**: the full green chain per `.claude/skills/testing-verification` — build, lint, test, test:e2e, compose healthy; plus a prod boot (`node dist/main` + `/health`) for config or bootstrap changes.
- **A new ADR is required** when a decision constrains future work or rejects an obvious alternative — the bar set by ADR 0001. Number sequentially; add a row to [docs/ADR/README.md](docs/ADR/README.md).
- **Session end**: update the phase table above; append decisions (never rewrite); anything half-decided becomes an explicit open question, not silent scope.
