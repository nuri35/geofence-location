# ADR 0009 — Bound connection acquisition, statement execution, and idle transactions

- **Status**: Accepted
- **Date**: 2026-08-08

## Context — the failure chain this closes

Three bounds were unset, and the consequence was proven by probe rather than
inferred: with pg's default `connectionTimeoutMillis = 0`, a request that finds
the pool exhausted **waits forever** — no error, no log, an open socket and a
pending promise (measured: a waiter sat silently past 4 s and proceeded only
when a connection was manually freed; with a bound it rejected in 1,503 ms).
The load measurement's "zero errors at every level" was partly this property
flattering itself.

The chain: a stalled commit (observed: 1.5–4.8 s, WSL2 WAL-fsync suspected)
holds a pooled connection; that user's retries each wait on the advisory lock
*while holding their own connections*; once the pool drains, every other user
queues indefinitely. The per-user lock is private; the connections it strands
are public. That is how one slow request degrades everyone — precisely what the
case's "large number of concurrent requests" requirement forbids.

Ranking correction from the adversarial review, reflected in the order below:
`statement_timeout` is the instrument everyone reaches for, but it bounds
neither dominant hold. The connection is held ~4 ms per request while Postgres
is active for under half of it — the rest is idle-in-transaction while Node
works between round trips, invisible to any statement timeout.

## Decision — three bounds, their numbers derived

| Bound | Value | Where applied |
| --- | --- | --- |
| Pool acquire | 2,000 ms | pg `connectionTimeoutMillis` via TypeORM `extra` |
| Statement ceiling | 5,000 ms | pg `statement_timeout` (per-connection server setting) via `extra` |
| Idle-in-transaction kill | 10,000 ms | pg `idle_in_transaction_session_timeout` via `extra` |
| Pool size | 10 (now explicit) | TypeORM `poolSize`, env-configurable |

- **Acquire 2 s** — the highest-leverage line: converts the proven silent hang
  into fast, visible shedding. Healthy acquire wait is ~0 ms (demand ≈ 6.4 of
  10), so any sustained wait already means stall or overload; 2 s outlasts one
  median stall so a single hiccup sheds nothing. This is also primitive
  backpressure at the narrowest existing choke point.
- **Idle-in-txn 10 s** — the only bound addressing where hold time actually
  goes. Normal idle-in-transaction here is milliseconds; ten seconds means a
  hung or leaked Node-side transaction. Protects against an application bug,
  not a slow query. Proven firing through the app's own factory output:
  Postgres logged `FATAL: terminating connection due to idle-in-transaction
  timeout` and the pool recovered without intervention.
- **Statement 5 s** — honestly scoped: provably bounds the advisory-lock convoy
  (the cancel was measured firing inside `lock_user_and_read_presence` at the
  lock-acquisition statement) and any future runaway query; it may not rescue a
  COMMIT stalled inside an fsync. Connection-level, not per-endpoint: measured
  normal is sub-millisecond on both read and write paths, so one >1000×
  ceiling is right; `SET LOCAL` is the escalation path if a legitimately slow
  statement ever appears. Set above the observed 4.8 s stall max on purpose —
  a first bound catches pathology, not the uncharacterized tail.
- **Pool 10** — unchanged in value, changed in status: from TypeORM default to
  explicit decision. At N=1, demand ≈ 1,600 req/s × ~4 ms ≈ 6.4 connections and
  the measurement proves more buys nothing (Node saturates first). At N
  instances: `poolSize = ceil(per_instance_peak_rps × mean_hold_s × 1.5–2)`,
  subject to `N × poolSize ≤ max_connections − ~10 reserved` (container default
  `max_connections = 100` caps N at 9 with pool 10; per-instance rps falls with
  N, so the formula self-corrects).

**Ordering enforced at boot** (Joi cross-field check, bad combinations
unrepresentable): `acquire (2s) < statement (5s) < idle-in-txn (10s)`. Waiting
longer for a connection than the bound on what holds connections just grows the
queue; and a session inside a legitimate long statement must never be culled as
idle.

**The migration CLI carries none of these** (`src/config/data-source.ts`): a
migration legitimately runs longer than 5 s (index builds, backfills), it is
operator-attended, and the shared-pool failure chain doesn't exist on a single
unpooled CLI connection.

## The client contract — 503 + Retry-After, not 500

All three timeout signatures (pg `57014` query_canceled, `25P03`
idle-in-transaction kill, pg-pool's acquire timeout) map in the catch-all
filter to `503` with `Retry-After: 5` and the house error shape; the driver
detail goes to the log only. Verified live through the prod artifact:

```
HTTP/1.1 503 Service Unavailable
Retry-After: 5
{"statusCode":503,"timestamp":"2026-08-08T06:53:54.393Z","path":"/locations","message":"Service temporarily unavailable, retry later"}
```

A 500 miscommunicates a transient condition; `Retry-After` = 5 s pushes the
retry past the observed stall envelope instead of inviting one at the worst
moment. Two design properties make retry-advice honest rather than a trap:
retrying `POST /locations` is semantically safe (`ON CONFLICT` absorbs the
duplicate by construction), and a timed-out write **self-heals without any
retry** — the rolled-back entry is re-detected by the user's next ping and
logged one interval late.

## The trade — successes given up, named

- A commit that would have survived a >5 s stall is now rolled back; its entry
  arrives one ping later with the later `recorded_at`. Real, bounded data
  change under pathology — priced against that stall no longer holding the
  pool hostage.
- A pool waiter that would have succeeded at +2.5 s now gets a 503. That *is*
  the requirement's trade: the many protected from the one.
- Any future legitimately slow feature pays a visible `SET LOCAL` tax.
- At ~8 entry events/s system-wide, the expected frequency of all of the above
  rounds to negligible; the asymmetry — bounded rare loss versus unbounded
  rare hang — is why the trade is right at this scale.

## Verification trail

- Acquire: probe rejected at 1,503 ms vs silent-forever default; e2e proves it
  through real HTTP (pool exhausted with query runners → 503 in 1.5–4.5 s).
- Statement: e2e holds the advisory lock → `POST /locations` 503 after >4.5 s
  with `Retry-After: 5` and no leak; live curl above.
- Idle-in-txn: factory-config script → server `FATAL` log line → pool recovery.
- Config path: e2e asserts `SHOW statement_timeout` = `5s` and
  `SHOW idle_in_transaction_session_timeout` = `10s` on the app's own pooled
  connections — config that takes effect, not config that merely exists.
- Ordering: unit tests reject misordered env combinations at boot.
- Normal traffic unaffected: 201/200 in ~30 ms through the same artifact.
