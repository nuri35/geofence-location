import { Injectable } from '@nestjs/common';

/**
 * Per-instance, in-memory counters for the ADR 0013 staleness exposure — reset on
 * restart, deliberately not an observability stack. Names and caveats:
 *
 * - invalidateFailedGetsOk: post-commit DEL failed while THIS request's GET had
 *   succeeded — the asymmetric flap that can suppress entries. The dangerous signal.
 * - invalidateFailedGetsFailing: DEL failed while the GET had also failed — the
 *   full-outage case, safe by construction (reads fall through to Postgres).
 * - changePathNoop: a transaction opened because the cache hint disagreed with
 *   Postgres, whose authoritative recompute then wrote nothing. Every suppressed
 *   visit ENDS with one of these (the exit sample heals the stale key), so this is
 *   an UPPER BOUND on suppressed entries — not a count of them: read-aside races
 *   and ordinary stale-"changed" hits produce the same signature.
 */
@Injectable()
export class PresenceMetricsService {
  private invalidateFailedGetsOkCount = 0;
  private invalidateFailedGetsFailingCount = 0;
  private changePathNoopCount = 0;

  recordInvalidateFailure(getsWereSucceeding: boolean): void {
    if (getsWereSucceeding) {
      this.invalidateFailedGetsOkCount += 1;
    } else {
      this.invalidateFailedGetsFailingCount += 1;
    }
  }

  recordChangePathNoop(): void {
    this.changePathNoopCount += 1;
  }

  snapshot(): Record<string, number> {
    return {
      presence_invalidate_failed_gets_ok_total: this.invalidateFailedGetsOkCount,
      presence_invalidate_failed_gets_failing_total: this.invalidateFailedGetsFailingCount,
      presence_change_path_noop_total: this.changePathNoopCount,
    };
  }
}
