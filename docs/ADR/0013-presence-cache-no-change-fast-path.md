# ADR 0013 — Redis presence cache with a no-change fast path (Phase N3)

- **Status**: Accepted
- **Date**: 2026-08-09

## Context

ADR 0007 rejected the first presence cache for a precise mechanical reason: under
cache-under-lock, the Redis hop sat on top of the Postgres round trip it was meant
to replace. ADR 0011's supersession note said the constraint moves in the target —
the read leaves the lock. This phase builds that shape in the synchronous service:
the cache is read WITHOUT the lock and WITHOUT a transaction, and the ~99%
no-change path stops opening a transaction at all. This is the exact fast-path
shape the N4 worker will run; what is decided here carries forward.

## Decision

    cache read (no lock, no txn) → diff empty  → return; nothing touched   (~99%)
                                 → diff exists → BEGIN, advisory lock,
                                                 RE-READ presence from Postgres,
                                                 recompute diff, write, COMMIT,
                                                 then DEL the key

**The cache answers "do I need to write?" — Postgres always answers "what do I
write?"** A stale cache saying "changed" costs one wasted transaction and writes
nothing (the locked recompute finds no diff); that direction is safe by
construction. The mechanics:

1. Key `presence:{userId}`, JSON string array; `"[]"` is a real value — "known to
   be in no areas" is distinguishable from "not cached".
2. A Redis **error is not a miss**: both fall through to an unlocked Postgres
   read, but only a clean miss writes the value back — an error write-back could
   resurrect state a concurrent invalidation just removed.
3. **Invalidate (DEL) after commit, never update-in-place**; the change path DELs
   even when the authoritative recompute wrote nothing, healing stale-"changed"
   keys. Lazy rebuild only — no bulk load after a Redis restart, ever.
4. **Every populate carries a TTL** (originally one knob, `PRESENCE_CACHE_TTL_S` 300 s; split by the addendum below into `PRESENCE_CACHE_TTL_NONEMPTY_S` 15 s / `PRESENCE_CACHE_TTL_EMPTY_S` 300 s): the
   bound on both ways a key can stay stale (below). This is the machinery ADR
   0007 said the rejected cache lacked, now cheap because it protects a fast path
   instead of sitting under a lock.
5. Redis client fails fast (command timeout 100 ms, no offline queue): a sick
   Redis costs bounded latency, never availability, and never correctness — the
   full suite passes with the container stopped (scenario 10, un-retired).
6. Redis is deliberately NOT in `/health`: a down Redis is a degraded-latency
   condition, not unhealthiness, and the probe's consumers act on "restart the
   pod", which would be wrong here.

## The dedup consequence, decided not discovered

The fast path opens no transaction, so decision 18's "dedup on every request"
cannot survive verbatim. Decided: **dedup runs only on the change path** — inside
the transaction, under the lock, exactly as before — which preserves the guarantee
that actually matters: **a replayed seq can never WRITE** (pinned by e2e: a
replayed old seq that would produce a re-entry is stopped under the lock with
`duplicate: true`, nothing stored). A no-change duplicate is absorbed by the
transition model itself and returns 201 `duplicate: false` — the label is lost,
the protection is not. This also retires the per-ping dedup write, the direction
ADR 0011 already named. Narrow regression accepted and recorded: `last_seq` now
advances only on change-path events, so a replayed no-change event whose seq was
never recorded can, after a cross-device state change, be processed as current
instead of flagged — within ADR 0010's "seq is dedup only, never ordering" and the
declared at-least-once non-goal.

## The stale-"unchanged" exposure — provoked, not argued

The dangerous direction is a stale key agreeing with the incoming point: the fast
path returns, the re-read never happens, the entry is silently lost. Provoked
deliberately in `test/stale-presence.e2e-spec.ts` (cache says `[A]`, database says
"in nothing" — equivalent to an exit whose post-commit DEL failed; then an event
inside A that must produce an entry):

- **The entry IS lost while the key is stale** — demonstrated, not theoretical:
  the event returns `enteredAreaIds: []` and no log row appears.
- **Recovery 1 — TTL expiry**: the next event after expiry misses, reads Postgres,
  sees the diff, and writes the entry. Delay ≤ TTL (proven with a 2 s TTL).
- **Recovery 2 — any differing sample**: an event that disagrees with the stale
  key opens the change path, which recomputes authoritatively and DELs the key;
  the very next inside event logs. No TTL wait involved.

**Exposure window under normal operation.** Invalidate-after-commit leaves a
gap of single milliseconds between COMMIT and DEL; an event landing inside it
wastes a transaction (safe direction) or, in the suppression direction, is
corrected by either recovery path. For a key to stay stale *longer* than that, one
of two things must go wrong: the post-commit DEL fails (Redis outage in exactly
that window — logged at WARN with the TTL), or the read-aside race lands (a
miss-populate whose unlocked read predates a concurrent commit's DEL and whose SET
lands after it). Both are failure/race conditions, not steady-state behaviour;
both are bounded by the TTL (worst case 300 s of suppression for that one user)
and healed earlier by any differing sample. **Verdict: reachable only through
failure or a narrow race, bounded, observable, self-healing — the fast path
survives.** If a real deployment cannot tolerate a worst-case 300 s suppression,
the knob is the TTL, paid for in one extra Postgres read per user per TTL.

## Measured (ABBA, same session, closed loop, 10k users)

Run order A1 B1 B2 A2 (A = N2 code, B = this phase). Machine drift between
brackets was again real (control static c=10: 2,922 → 2,535 across the session) —
single comparisons would have lied in both directions.

| workload | c | A1 | B1 | B2 | A2 | adjacent gains |
| --- | --- | --- | --- | --- | --- | --- |
| static | 10 | 2,922 | 4,568 | 4,729 | 2,535 | +56% / +87% |
| static | 50 | 2,911 | 5,497 | 5,357 | 2,620 | +89% / +104% |
| static | 200 | 2,858 | 4,950 | 4,960 | 2,537 | +73% / +96% |
| static | 500 | 2,873 | 5,100 | 5,005 | 2,525 | +78% / +98% |
| transition | 10 | 2,240 | 1,927 | 1,788 | 2,139 | −14% / −16% |
| transition | 50 | 2,338 | 1,678 | 1,826 | 2,066 | −28% / −12% |
| transition | 200 | 2,263 | 2,089 | 1,868 | 2,103 | −8% / −11% |
| transition | 500 | 2,200 | 1,965 | 1,937 | 2,117 | −11% / −9% |

- **Static +56–104%, positive in all eight comparisons**, p50 at c=10 down
  3.3 → 1.9 ms, cache hit rate ≈ 1.0 in steady state, and **Postgres untouched**
  (pg_stat sampling: avg active connections ≈ 0). The prediction held: the gain
  is the three dropped round trips (BEGIN, folded lock+read, COMMIT), and at
  ~5,000–5,500 req/s the path sits at the previously measured bare-404 Node
  ceiling — the request is now HTTP + one Redis GET.
- **Which mechanism does the work: the fast path, with the cache as its enabler.**
  At c=10 the hit rate was still climbing (0.81) and throughput was already
  4,568; misses skip the transaction too (one unlocked SELECT instead of
  BEGIN+lock+read+COMMIT). The cache's own contribution is the step from that to
  hit≈1.0 (~5,100–5,500) — removing the last Postgres read entirely.
- **Transition −8 to −28%, negative in all eight comparisons — a real cost, not
  noise.** Mechanically expected: a 50%-flip workload is the cache's worst case
  (hit rate ~0.5); every flip pays GET + DEL, every miss pays GET + unlocked
  SELECT, all on top of the unchanged transaction. The trade is bought for the
  real traffic shape (~99% no-change per ADR 0011), where the fast path
  dominates: at 99% static / 1% transition the blend is decisively positive.

## What N4 inherits

- The fast-path shape verbatim: cache-outside-lock, verify-under-lock on writes,
  invalidate-after-commit, TTL as the staleness bound, error ≠ miss, lazy rebuild.
- The dedup contract above (no-change duplicates unlabeled; writes always
  guarded) — the worker's per-partition in-memory dedup restores per-event
  labeling later, per ADR 0011.
- The exposure analysis: ack-after-commit plus redelivery does not change the
  stale-"unchanged" math; the TTL and differing-sample healing carry over.

## Addendum (2026-08-09, same-day review) — differentiated TTL, counters, and the honest framing

**What this design actually means, stated plainly.** "Postgres authoritative, Redis
ephemeral" is true but incomplete, and the incompleteness is the whole risk: **a
stale hit is allowed to suppress the authoritative read.** During the TTL window,
Redis availability affects correctness — a genuine entry can go unlogged. The
framing above is not softened by the mitigations; it is bounded by them.

**Differentiated TTL — the asymmetry is the point.** The flat TTL was replaced by
two clocks: non-empty membership **15 s** (`PRESENCE_CACHE_TTL_NONEMPTY_S`), the
empty set `"[]"` **300 s** (`PRESENCE_CACHE_TTL_EMPTY_S`), both env-configurable.
Reasoning: a stale `"[]"` heals on the next inside ping, because a non-empty
computed set immediately disagrees with it and opens the change path; the only
thing it can suppress is an exit deletion, whose cost is a merged visit — which
this system already tolerates by declared non-goal, and which a GPS gap produces
anyway. A stale **non-empty** value is the entry-killer: all of the fatal
direction lives there, so that is where the short clock goes. Worst-case entry
suppression drops 300 s → 15 s. Honest cost: users dwelling inside an area now
refresh via one unlocked Postgres SELECT every 15 s each — no lock, no
transaction, no per-event change. Both behaviours are pinned by
`test/stale-presence.e2e-spec.ts` (a stale non-empty key expires on the short
clock; a stale `"[]"` heals on the next inside ping and merges visits at worst).

**Two counters** (`GET /metrics` — per-instance, in-memory, reset on restart;
deliberately not an observability stack):

- `presence_invalidate_failed_gets_ok_total` / `presence_invalidate_failed_gets_failing_total`
  — failed post-commit DELs, **qualified by whether the same request's GET
  succeeded**. The distinction is load-bearing: a full outage is the *safe* case
  (GETs fail too, everything falls through to Postgres correctly); the dangerous
  signal is the asymmetric flap — DEL failing while GETs still serve.
- `presence_change_path_noop_total` — transactions the cache hint opened whose
  authoritative recompute wrote nothing. Every lost visit ends with exactly this
  event (the exit sample disagrees with the stale key, the change path opens,
  finds nothing to write, and finally DELs it), so the counter is an **upper
  bound on suppressed entries per window — not a count of them**: read-aside
  races and ordinary stale-"changed" hits produce the same signature.

> Scope annotation (2026-08-09, N5B — [ADR 0018](0018-worker-local-presence.md)):
> these counters now answer a narrower question than the one they were built
> for. The worker never reads Redis, so the stale-cache mechanism whose
> signature they trace exists only on the parked API-side path — and
> `GET /metrics` is served by the API process alone, so that path is the only
> surface they observe. The worker process still increments them (its hygiene
> DEL can fail; its memory/Postgres hint can open a no-op transaction), but
> those increments are invisible — the worker has no metrics surface (the gap
> ADR 0018 records). Read them as parked-path instrumentation, not system-wide
> staleness telemetry.

**Rejected directions, recorded because each will be asked again:**

- **Fencing / version tokens: rejected permanently.** In the dangerous case the
  two inputs to the fast path — computed membership and cached value — are
  bit-identical to the healthy case. Detection needs a third input, and every
  candidate shares fate with something: a token in Postgres puts Postgres back on
  the hot path; a version key in Redis fails in exactly the window the DEL
  failed. The problem is not representation; it is that the only party who knows
  about the commit is the store you couldn't reach.
- **Outbox / transactional invalidation queue: not now.** It converts "stale
  until TTL" into "stale until Redis recovers plus sweep interval" — but during
  the flap that caused the failure, the sweeper's DELs are failing too. Its
  marginal value over a short TTL is narrow. Revisit if the flap counter shows
  sustained non-zero.
- **Failing the request when the DEL fails: rejected.** The commit already
  succeeded; returning 5xx reports a true success as a failure. It also does not
  close the hole — a process dying between COMMIT and DEL leaves no response to
  fail.
- **Double-DEL (delete before commit as well as after): held in reserve.**
  Exposure would then require both DELs to fail, and the pre-commit failure is
  knowable *before* committing — turning the loss estimate from a bound into a
  measurement. One extra DEL per transition (~1% of events). Build it if the
  counters show real numbers.
- **Caching only the empty set: open, pending a measurement.** It would make the
  dangerous direction stop existing (an entry event then always sees a non-empty
  diff or a miss — Postgres is consulted before anything can be suppressed), at
  the cost of an unlocked SELECT on every dweller ping. The deciding number, not
  yet measured: **the share of no-change traffic whose membership is non-empty.**
  If it is small (commuter-like traffic, mostly outside all areas), the variant
  keeps nearly all of the fast path's gain and deletes the failure mode; if
  dwell-heavy, the differentiated TTL is the better trade. Measure it from the
  counters'/logs' hit shape before N4 freezes the worker's cache policy.

**The acceptability argument, because it is the load-bearing one.** The loss
requires exit → asymmetric invalidation failure → re-entry into the *same area*
within the TTL. The population that re-enters a geofence within seconds of
leaving it is overwhelmingly the boundary-oscillating GPS-jitter case — the same
events whose semantics were already declared weakest when hysteresis was scoped
out (SCOPE.md). The residual loss concentrates precisely where the product
already said precision ends.

**Note for N4:** post-hoc repair is impossible in this design — a suppressed
entry was never durably captured anywhere. Once events land in the partitioned
queue before processing, a suspected stale window becomes **replayable**; the
counters above then tell an operator *when* to replay.

## Resolution (2026-08-09, Phase N5B — [ADR 0018](0018-worker-local-presence.md))

The stale-"unchanged" hazard this ADR documented, provoked, bounded, and
counted is now **structurally gone from the hot path**: in the worker, presence
lives in process memory — the writer and the reader are the same process, so
there is no invalidation to lose — and cold reads seed from Postgres, never
Redis, so a stale key cannot enter a store without a TTL. Redis's presence
role narrows to the parked API-side path (which keeps this ADR's shape, TTL
and counters unchanged until it is deleted) and to receiving post-commit DELs
so no future reader ever finds a stale key. The differentiated TTLs, the two
counters, and the provocation spec remain in force for that remaining surface.

## Alternatives considered

- **Consulting dedup state on the fast path** (a Postgres or Redis read) —
  rejected: it re-adds a per-ping store round trip to the path whose entire point
  is touching nothing, to preserve a response label the transition model makes
  redundant.
- **Updating the key in place after commit instead of DEL** — rejected: an update
  is a second writer to the same key and races concurrent populates; DEL makes
  the next reader rebuild from truth (and ADR 0007's history is a warning about
  clever invalidation).
- **Bulk-rebuilding the cache after a Redis restart** — rejected: lazy rebuild
  costs one unlocked read per user exactly once; a bulk load is a thundering herd
  with no correctness benefit.
- **No TTL (pure invalidate-after-commit)** — rejected: the provocation shows the
  suppression direction has no other time bound; "stale until something else
  happens" is exactly what ADR 0007 refused to ship.
