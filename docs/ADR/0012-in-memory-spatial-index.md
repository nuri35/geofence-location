# ADR 0012 — In-memory spatial index with versioned snapshot (Phase N2)

- **Status**: Accepted
- **Date**: 2026-08-09

## Context

ADR 0003 kept point-in-polygon in PostGIS "until the per-request round trip is a
measured bottleneck." The stub measurement (ADR 0003, third annotation) fired that
condition: removing the spatial round trip was worth +43–50% throughput in its
session, and the cost it removed was Node-side scheduling, not database execution.
ADR 0011 already placed the polygons in worker memory in the target architecture.
This phase builds that component inside the synchronous service — a real
optimisation today and the rehearsal for the code that moves into the N4 worker.

## Decision

1. **`AreaSpatialIndex`** (`src/areas/spatial-index.ts`) — a pure class, no Nest, no
   database: rbush bounding-box prefilter, then exact containment with
   `@turf/boolean-point-in-polygon` (`ignoreBoundary: false`) — the same two-stage
   shape the GIST index executes (bbox operator + recheck), in Node. This class is
   what the N4 worker lifts unchanged.
2. **`AreaSnapshotService`** (`src/areas/area-snapshot.service.ts`) — Nest wrapper
   owning lifecycle: builds the index from Postgres at bootstrap, polls a version
   counter, rebuilds on change, swaps **one reference** atomically. Rebuilds are
   serialized through a promise chain so a slow older build can never overwrite a
   newer one. `AreasService.findCoveringAreaIds` — the only hot-path call site —
   delegates to it; nothing else in the transition path changed.
3. **Version storage**: a singleton Postgres table `area_version(id smallint PK
   CHECK(id=1), version bigint)`. `POST /areas` bumps it with
   `UPDATE … SET version = version + 1` **in the same transaction as the area
   insert**, so no observer can read a version that runs ahead of or behind the
   areas it describes. After commit, the creating instance refreshes its own
   snapshot synchronously before responding — single-instance deployments see zero
   staleness, and every acceptance scenario keeps its semantics.
4. **Polling**: every instance polls the version (one trivial `SELECT`) every
   **30 s** — ADR 0011's figure, kept: the poll costs microseconds of database
   time per instance per interval, and the product cost is honest and bounded — an
   area created on *another* instance takes up to 30 s + one rebuild to take effect
   there. Env-tunable (`AREAS_POLL_INTERVAL_MS`, Joi floor 250 ms) for tests and
   operations. Redis pub/sub instant invalidation is deliberately NOT part of this
   phase (ADR 0011 schedules it); polling self-heals — a missed notification does
   not exist in a design that has no notifications.
5. **Rebuild failure**: at runtime, keep the stale index, log a warning, retry next
   poll — polygons are near-static and the hot path no longer depends on the
   database, so a transient DB blip must not take down location processing; only
   staleness is bounded, never availability. At **bootstrap** the opposite: a failed
   first build aborts boot, because an empty index answers "nothing covers
   anything" — wrong answers, not stale ones.
6. **PostGIS keeps** geometry truth, the `ST_IsValid` gate on `POST /areas`, the
   `chk_areas_boundary_valid` CHECK constraint, and the GIST index. Only the
   per-request query left the hot path. The old query survives as
   `findCoveringAreaIdsViaPostgis` — off the hot path, the reference arm of the
   equivalence harness. All three re-verified live after the switch: bowtie → 400
   with `ST_IsValidReason`; direct SQL insert of an invalid polygon rejected by the
   CHECK; `\d areas` shows constraint and GIST index.

## The equivalence proof (the gate, passed first)

`ST_Covers` counts the boundary line as inside (decision 2). turf has its own
boundary semantics; if they disagreed, the system would silently return different
answers exactly on boundaries. So the first artifact of this phase was
`test/spatial-equivalence.e2e-spec.ts`: ~840 deterministic probe points — every
vertex, edge midpoints, t=1/3 and t=1/7 along every segment (non-representable
fractions), perpendicular offsets ±1e-9 and ±1e-12 from edge midpoints, hole
interiors and hole-ring points, shared edges between adjacent polygons, overlap
interiors, bbox corners, and a 23×23 grid — each run through **both** the PostGIS
query and the in-memory index, answers compared as sorted sets.

**Result: zero mismatches.** `booleanPointInPolygon(…, { ignoreBoundary: false })`
reproduced `ST_Covers` exactly on every probe, including hole-ring boundaries
(a hole's ring is boundary, therefore inside — both engines agree). No wrapper was
needed. A negative control was run before trusting the green: flipping to
`ignoreBoundary: true` makes the harness fail on the boundary points, proving the
harness can detect divergence. The spec is kept permanently — it is the tripwire
for a turf or PostGIS upgrade changing boundary behaviour.

## Measured results

Method: same harness (`scripts/measure-presence.mjs`), same box, closed-loop,
10,000 users, 12 s runs at c=10/50/200/500 — **ABBA bracketing in one session**
(control, candidate, candidate, control), adopted after the first pair showed
run-to-run machine drift up to ±15–20% (control-vs-control static c=10 fell
2,353 → 2,000 across the session; the prior session's warning about cross-session
comparison applies within a long session too).

Throughput, req/s (A = PostGIS control, B = in-memory candidate, in run order
A1 B1 B2 A2):

| workload | c | A1 | B1 | B2 | A2 | adjacent-pair gain |
| --- | --- | --- | --- | --- | --- | --- |
| static | 10 | 2,353 | 2,873 | 2,485 | 2,000 | +22% / +24% |
| static | 50 | 2,328 | 2,828 | 2,320 | 2,054 | +21% / +13% |
| static | 200 | 2,284 | 2,726 | 2,312 | 2,175 | +19% / +6% |
| static | 500 | 2,195 | 2,505 | 2,413 | 1,945 | +14% / +24% |
| transition | 10 | 1,971 | 1,636 | 1,610 | 1,672 | −17% / −4% |
| transition | 50 | 1,775 | 1,560 | 1,679 | 1,764 | −12% / −5% |
| transition | 200 | 1,778 | 1,705 | 1,861 | 1,629 | −4% / +14% |
| transition | 500 | 1,812 | 1,789 | 1,963 | 1,589 | −1% / +24% |

- **Static (no-change pings, the ~99% shape of the target): +6–24%, positive in
  all eight adjacent comparisons.** p50 at c=10 dropped 4.1→3.3 ms and 4.9→3.7 ms —
  roughly 0.8–1.2 ms of per-request latency removed, which is the spatial round
  trip plus its scheduling.
- **Transition: no attributable effect.** Sign flips between brackets; the
  apparent −17% in the first pair reproduced *in the control itself* (A2 transition
  c=10: 1,672, matching the candidate's 1,610–1,636) — it was session drift, not
  the index. Mechanically this is expected: a flipping request is dominated by the
  write transaction (lock, inserts, delete, commit), so removing one read round
  trip moves it little.
- **Against the stub's +43–50%**: roughly half materialized, on the workload where
  the round trip was the biggest share of request cost. The gap says three things:
  the stub did zero work where the real index does real (if tiny) work; the stub's
  single-window comparison rode a favourable machine state that ABBA bracketing
  refuses to credit; and the stub's transition gain was never the round trip — it
  was noise. The stub was an upper bound, and behaved like one.

**What the phase costs that the stub didn't** (measured):

| Cost | 2 areas | 10,002 areas (65-vertex avg) |
| --- | --- | --- |
| Startup build (in-process, real boot) | 8.4 ms | 192 ms |
| Live rebuild while serving | — | 228 ms |
| Heap footprint of the snapshot | negligible | **~49 MB** (47.3 MB parsed GeoJSON + 1.8 MB rbush tree ≈ 5 KB/polygon) |
| Version poll | one `SELECT` per instance per 30 s | same |

## Memory per instance, and the trigger deliberately not pulled

Polygons are duplicated in every instance's RAM. At this project's scale (hundreds
of areas) that is ~1–2 MB and irrelevant. The 10k measurement prices the future:
~49 MB and ~0.2 s per instance — still fine for a handful of instances, but at tens
of thousands of polygons × many workers starting at once (deploy, partition
rebalance), startup parse work and duplicated footprint become a real cost. The
remedy recorded in SCOPE.md ("prepared polygon snapshot") — a versioned, prepared
artifact workers load instead of each parsing Postgres output independently — is
**deliberately not built**: the trigger is tens of thousands of polygons or
rebuild time approaching the poll interval, and neither is within an order of
magnitude of true today. Query speed is not part of the trigger: the R-tree stays
logarithmic and was never the constraint.

## Known hazard accepted

An area deleted **out of band** (raw SQL — there is no DELETE endpoint; update /
delete semantics are a declared non-goal) stays in every other instance's snapshot
for up to one poll interval. A report inside it during that window resolves the
dead area id, and the presence INSERT fails on the foreign key → that request gets
a 500 and self-heals on the user's next ping after the poll catches up. Bounded,
self-healing, and unreachable through the API today — recorded rather than
engineered around.

## What Phase N4 must change when this moves into the worker

- `AreaSpatialIndex` moves as-is; `AreaSnapshotService`'s DB loading and polling
  survive; its Nest lifecycle hooks (bootstrap/destroy) become worker
  start/shutdown, and `refreshNow()`'s caller disappears — in N4 `POST /areas`
  lives in the API tier, so *every* instance learns via version bump + (N4's)
  published invalidation; the synchronous local-refresh guarantee is an artifact of
  this phase only.
- The poll moves from "each API instance" to "each worker" unchanged; pub/sub
  invalidation is added on top, with the poll demoted to self-healing.
- The FK-on-deleted-area hazard needs a decision before workers ack after commit
  (redelivery of a poisoned event must not loop forever).

## Alternatives considered

- **Version via `count(*)`/`max(created_at)`** — rejected: no explicit bump point,
  and silently wrong the day areas become updatable or deletable.
- **A Postgres sequence** — rejected: increments survive rollback (a failed create
  would still invalidate every snapshot) and reading without consuming is awkward;
  the singleton row is transactional with the insert by construction.
- **LISTEN/NOTIFY or Redis pub/sub now** — rejected for this phase: ADR 0011
  schedules push invalidation for the worker phases; polling alone is the
  self-healing core and is sufficient at a 30 s staleness budget.
- **Hard failure on runtime rebuild errors** — rejected: it converts a one-poll
  database blip into a full outage of a path that no longer needs the database;
  the failure mode this design accepts (bounded staleness) is strictly milder than
  the one it avoids (unavailability).
- **Handling concurrent rebuilds with a mutex/last-writer-wins** — rejected in
  favour of a serialized promise chain: last-writer-wins allows an older build to
  finish after a newer one and swap the snapshot backwards.
