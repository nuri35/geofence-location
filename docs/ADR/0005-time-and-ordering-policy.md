# ADR 0005 — Time and ordering policy

- **Status**: Accepted
- **Date**: 2026-08-07

## Context

Mobile clients deliver location samples late, twice, and out of order, with
clocks skewed by minutes. The log's timestamp must come from a clock the system
controls, and the question is whether client-reported time should participate
in ordering or state decisions at all.

## Decision

- **`recorded_at`** — assigned server-side at receipt — is authoritative for
  **both ordering and the logged time**. Processing order is server arrival
  order. All timestamps are `timestamptz`.
- **`observed_at`** — client-reported, nullable — is stored for informational
  purposes only and **participates in no logic**: no rejection, no comparison,
  no state. It is context for a human reading the data, nothing more.
- **`last_seen_at`** lives on the presence row and means only "when this
  membership last changed". It is written when the row is written, never on a
  read-only request, and it is not a decision input.

## Alternatives considered

- **Client timestamps authoritative** — rejected: minutes of skew are normal,
  cross-user ordering becomes fiction, and the value is client-controlled.
- **A staleness guard comparing `observed_at` against the last accepted
  `observed_at`** — the first draft of this ADR — rejected on review: server
  arrival time already defines processing order, so the guard defended against
  a case the server clock already handles, at the price of a per-user state row
  written on every request and a clock-domain comparison. It also let a client
  with a skewed-fast clock suppress its own subsequent updates.
- **Client sequence numbers** — the real fix for in-transit reordering, and the
  only one that works without trusting client clocks. Rejected for this case:
  it changes the client contract, and a technical case has no real client to
  hold to it. The cost of living without it is recorded in docs/SCOPE.md.

## Consequences

Positive:

- One clock, one ordering rule, no per-user hot row on the read-mostly path,
  no clock-domain arithmetic anywhere in the system.
- The write path stays exactly ADR 0002's transaction — nothing precedes it but
  the advisory lock.

Negative / accepted honestly:

- A location sample delayed in transit is processed as if it were current: a
  stale sample can produce a wrong transition (expanded in docs/SCOPE.md,
  "Out-of-order sample protection"). This is the deliberate price of dropping
  the guard; the remedy, if ever needed, is client sequence numbers — not a
  return to client-clock comparisons.
