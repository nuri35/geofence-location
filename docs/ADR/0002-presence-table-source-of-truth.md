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
key holds current membership; PostgreSQL is the source of truth. Per accepted
location report, in **one transaction**:

1. Compute the current area set with the spatial query (ADR 0003).
2. `INSERT INTO user_area_presence … ON CONFLICT DO NOTHING RETURNING …` for
   the current set. The rows actually returned are precisely the entries.
3. Insert one log row per returned row. A log is emitted **only** for a
   returned row — of two racing identical requests, exactly one insert returns
   the row, so exactly one log is written, enforced by the database rather than
   by application discipline.
4. Delete this user's presence rows for areas not in the current set (exit
   maintenance; exits are not logged — a declared non-goal, see docs/SCOPE.md).

Commit, or none of it happened. A user entering three overlapping areas in one
report gets three returned rows and three logs — the transition is a set
difference, not a single value (decision 5). A first-ever observation inside an
area produces entries by the same mechanism; this is recorded as an accepted
assumption, not an observed transition (decision 9).

Redis fronts this table as a **read-through cache only**: lazy loading on miss,
negative caching for empty membership, updated only after the owning
transaction commits. A stale or missing cache entry costs one primary-key
lookup; it can never change what gets logged, because logging is decided by the
`RETURNING` clause, never by the cache.

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
  must be an explicit rule over `last_seen_at` (ADR 0005) — a product decision
  — never a cache-TTL side effect.
- `ON CONFLICT` serializes duplicate *inserts*; it does not serialize an insert
  racing a *delete* — an enter-sample and an exit-sample from the same user
  processed concurrently can interleave. ADR 0005's staleness guard narrows
  that window only when the client supplies `observed_at`. Full per-user
  serialization (advisory lock) is deliberately not attempted until the
  interleaving is observed in practice.
