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
4. **Every populate carries a TTL** (`PRESENCE_CACHE_TTL_S`, default 300 s): the
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
