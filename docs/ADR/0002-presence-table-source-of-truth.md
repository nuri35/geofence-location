# ADR 0002 — Presence table in PostgreSQL as the source of truth for area membership

- **Status**: Accepted
- **Date**: 2026-08-07

## Context

"Entered an area" is a transition, not a state: a user inside an area for ten
minutes must produce exactly one log, so every `POST /locations` request needs
the user's *previous* membership, not just the current point. Whatever holds
that previous state sits on the hot path (~1,000 req/s assumed), is contended by
concurrent requests from the same user — mobile delivery is effectively
at-least-once, so identical concurrent samples are a certainty, not an edge
case — and must never disagree with the log the system emits.

## Decision

A mutable table `user_area_presence(user_id, area_id)` with a composite primary
key holds current membership; PostgreSQL is the source of truth. Per location
report, in **one transaction**:

1. `SELECT pg_advisory_xact_lock(hashtext(user_id))` — the transaction's first
   statement. It serializes concurrent requests for the same user, closing the
   insert-vs-delete interleaving (an enter-sample and an exit-sample processed
   concurrently), and releases automatically at transaction end. Different
   users never contend, so at this scale the lock costs nothing.
2. Compute the current area set with the spatial query (ADR 0003).
3. `INSERT INTO user_area_presence … ON CONFLICT DO NOTHING RETURNING …` for
   the current set. The rows actually returned are precisely the entries.
4. Insert one log row per returned row. A log is emitted **only** for a
   returned row — of two racing identical requests, exactly one insert returns
   the row, so exactly one log is written, enforced by the database rather than
   by application discipline.
5. Delete this user's presence rows for areas not in the current set (exit
   maintenance; exits are not logged — a declared non-goal, see docs/SCOPE.md).

The lock does not replace `ON CONFLICT DO NOTHING` — both stay. The lock orders
same-user work; the constraint is what makes the log-or-not decision correct,
and it is the backstop if the lock is ever bypassed.

Commit, or none of it happened. A user entering three overlapping areas in one
report gets three returned rows and three logs — the transition is a set
difference, not a single value (decision 5). A first-ever observation inside an
area produces entries by the same mechanism; this is recorded as an accepted
assumption, not an observed transition (decision 9).

Redis fronts this table as a **read-through cache only**, with two mechanisms
fixed here:

- **Encoding**: the cached membership is a JSON array stored as a plain string
  value — not a Redis SET. The empty set is the string `"[]"`, a real value
  that distinguishes "known to be in no areas" (negative caching) from "not
  cached" (key absent); a Redis SET cannot represent an empty set, because
  empty set keys do not exist.
- **Post-commit behaviour**: the cache is **invalidated** after commit, never
  updated. Deleting a key is idempotent and safe to lose; writing a computed
  value after a transaction can race another request's write and persist a
  stale set.

A stale or missing cache entry costs one primary-key lookup; it can never
change what gets logged, because logging is decided by the `RETURNING` clause,
never by the cache.

**Cache-under-lock (correctness constraint, discovered in Phase 3):** the cache
read, its population, and the in-flight invalidation all happen INSIDE the
transaction, under the advisory lock. A cache value read before the lock can
already have been invalidated by a concurrent same-user request — and on the
**exit** side there is no `ON CONFLICT` backstop: acting on that stale set
would silently swallow a genuine re-entry. The lock is per-user, so ordering
the cache behind it costs nothing across users. Population is also safe
against rollback by construction: the value written is the *pre-transition*
database read, which is exactly the state a rollback restores; an invalidation
followed by rollback merely causes one extra database read. A second
invalidation runs after commit, failures swallowed — belt-and-braces, since a
cache left empty is always harmless.

## Alternatives considered

- **Derive previous state from the logs table** — rejected. The most recent log
  answers "where did this user last *enter*", not "where is this user *now*": a
  user who exits and re-enters has the second entry silently swallowed, because
  the latest log already names that area.
- **Redis as the source of truth (the original design)** — rejected after
  review, honestly: this was the design going into Phase 0. Four independent
  failures killed it. (a) TTL expiry while a user sits inside an area
  manufactures a phantom re-entry on their next report, and an expired key is
  indistinguishable from genuine absence. (b) The read-modify-write cycle is
  not atomic, so two concurrent requests from one user both compute the same
  diff and duplicate the log. (c) Multiple application instances race on the
  same key, and the load assumption forces multiple instances. (d) State and
  log cannot commit together — either a failed log insert loses the event
  forever or a failed state write duplicates it on the next report. The
  mitigations that design needed (AOF persistence, a fallback dedup query that
  transfers Redis's load onto Postgres at the exact moment the system is
  degraded, a confidence column on log rows) all exist to compensate for these
  four; the presence table makes every one of them unnecessary.
- **In-process cache** — rejected. Correct only while there is exactly one
  instance; it breaks the moment the API tier scales horizontally.

## Consequences

Positive:

- State and log are atomic: no ordering-of-writes question, no compensation
  logic, no partially applied transition.
- Concurrent duplicate entries are impossible at the database level
  (`ON CONFLICT` + `RETURNING`), including across multiple app instances.
- Redis's entire failure surface is reduced to latency; no persistence tuning,
  no degraded-mode code path, no data-quality markers.
- Presence rows never expire, so there is no phantom-entry class at all.

Negative / accepted honestly:

- One primary-key lookup per request (served by the cache when warm) and a
  transaction on every write-path request.
- Presence rows never expire: a user absent for a month is still "inside", and
  their return produces no new entry. If absence-based reset is ever wanted, it
  must be an explicit product rule — and would need a per-user last-report
  timestamp the schema deliberately does not keep (the presence row's
  `last_seen_at` records membership changes only, ADR 0005) — never a
  cache-TTL side effect.
- Advisory locks are per-database and do not survive connection pooling in
  transaction mode (e.g. pgbouncer): `pg_advisory_xact_lock` is
  transaction-scoped so it works under transaction pooling *today*, but any
  future move to session-scoped advisory locks or a pooler that multiplexes
  mid-transaction breaks the serialization silently. Noted, not solved;
  `ON CONFLICT` remains the correctness backstop either way.

## Addendum (2026-08-07)

The read-through cache described above was built, measured
(docs/PRESENCE_READ_MEASUREMENT.md), and **removed** — ADR 0007 records both
reasons: it lost the measurement, and review found a correctness hole
(invalidations lost across a Redis outage leave a stale key that is served as a
hit under the lock and can suppress a genuine re-entry log). The
**cache-under-lock constraint stays recorded here deliberately**: it is the
minimum bar any future presence cache must clear, and the stale-hit hole is the
second requirement (verify-on-hit or TTL) discovered after this ADR was
written. PostgreSQL as the sole source of truth — this ADR's actual decision —
is unchanged and is now also the only presence-read implementation.
