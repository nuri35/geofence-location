# ADR 0005 — Time and ordering policy

- **Status**: Accepted
- **Date**: 2026-08-07

## Context

Mobile clients deliver location samples late, twice, and out of order, with
clocks skewed by minutes. A sample applied out of order corrupts presence state
twice over: it can log a phantom entry for an area the user already left, and
the now-wrong state swallows the next genuine entry. Separately, the log's
timestamp has to come from a clock the system actually controls.

## Decision

- **`recorded_at`** — assigned server-side at receipt — is authoritative for
  log rows and for all ordering. All timestamps are `timestamptz`.
- **`observed_at`** — client-reported, nullable — is stored as informational
  context only. It has exactly one power: a request whose `observed_at` proves
  it older than the user's `last_seen_at` is rejected without touching state.
  It never mutates state on its own and never overrides server ordering.
- Processing order is server arrival order. `last_seen_at` is the greatest
  accepted `observed_at` per user — client clock compared only against itself,
  never across clock domains — updated on every accepted request that carries
  an `observed_at`. Where it lives (a user-level row alongside presence) is
  fixed by the Phase 1 schema.

## Alternatives considered

- **Client timestamps authoritative** — rejected: minutes of skew are normal,
  cross-user ordering becomes fiction, and the value is client-controlled.
- **Client sequence numbers** — rejected for this case: a genuinely stronger
  ordering guarantee than a stale-drop guard, but it changes the client
  contract, and in a technical case there is no real client to hold to it.

## Consequences

Positive:

- Log timestamps are consistent and assigned by one clock.
- The worst out-of-order corruption — a stale sample resurrecting an area the
  user already exited — is blocked whenever the client supplies `observed_at`.

Negative / accepted honestly — **this is a guard, not an ordering protocol**:

- A request without `observed_at` gets no staleness protection at all.
- A client with a skewed-fast clock can suppress its own updates: one sample
  with a far-future `observed_at` raises `last_seen_at` past every genuine
  sample that follows, until the real clock catches up. The damage is scoped to
  that one user and self-inflicted; a plausibility window on `observed_at` is a
  known mitigation, deferred until the behaviour is observed.
- Two requests arriving in the same instant are not ordered by this policy;
  their interleaving is bounded only by ADR 0002's `ON CONFLICT` guarantee.
