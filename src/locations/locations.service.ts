import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AreasService } from '@app/areas/areas.service';
import { LOGS_TABLE } from '@app/logs/entities/log.entity';
import { PresenceCacheService } from '@app/presence/presence-cache.service';
import { PresenceMetricsService } from '@app/presence/presence-metrics.service';
import { PRESENCE_TABLE } from '@app/presence/entities/presence.entity';

import { USER_EVENT_STATE_TABLE } from './entities/user-event-state.entity';
import { MAX_ACCURACY_METERS } from './locations.constants';
import { LocationReportResponseDto, ReportLocationDto } from './dto';

interface AreaIdRow {
  area_id: string;
}

interface LastSeqRow {
  last_seq: string;
}

@Injectable()
export class LocationsService {
  constructor(
    private readonly areasService: AreasService,
    private readonly presenceCache: PresenceCacheService,
    private readonly presenceMetrics: PresenceMetricsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * OFF THE HTTP PATH SINCE N4B (ADR 0015): no controller calls this — POST
   * /locations publishes to the queue instead. This method IS the transition
   * processor N4C mounts in the worker; it stays fully covered by its unit suite
   * and by the service-level e2e specs until then. Deleting it in N4B would have
   * left the repository with no working transition path at all between phases.
   *
   * The ADR 0002 transition path behind the ADR 0013 no-change fast path. The cache
   * answers ONE question — "do I need to write?" — read without the lock and without
   * a transaction. Postgres always answers "what do I write?": every writing path
   * re-reads presence authoritatively under the advisory lock and recomputes the
   * diff there. A stale cache saying "changed" costs a wasted transaction and writes
   * nothing; a stale cache saying "unchanged" suppresses the fast path for at most
   * the cache TTL (the exposure ADR 0013 measures and records).
   */
  async report(
    dto: ReportLocationDto,
    // recorded_at is the time the SYSTEM accepted the event (decision 8), captured
    // once and passed to both the presence row and its log row so they cannot
    // disagree. The default is "now" (the synchronous/service-level path); the N4C
    // worker passes the message's receivedAt instead — under backlog the log must
    // record acceptance time, never worker-processing time (ADR 0015/0016).
    recordedAt: Date = new Date(),
  ): Promise<LocationReportResponseDto> {
    // ADR 0010: semantic gate, deliberately 422 not 400 — the request is well-formed;
    // a reading with this error radius just cannot answer "inside or outside".
    if (dto.accuracy !== undefined && dto.accuracy > MAX_ACCURACY_METERS) {
      throw new UnprocessableEntityException(
        `accuracy ${dto.accuracy}m exceeds the usable maximum of ${MAX_ACCURACY_METERS}m: a reading this uncertain cannot be checked against area boundaries`,
      );
    }
    // ADR 0010: capturedAt replaces observedAt; the deprecated alias is honored for
    // pre-contract clients, capturedAt winning when both are sent.
    const capturedAt = dto.capturedAt ?? dto.observedAt ?? null;

    // [1] Pure in-memory read (ADR 0012) — no database.
    const currentAreaIds = await this.areasService.findCoveringAreaIds(dto.lng, dto.lat);

    // [2] Previous membership HINT: cache first, read OUTSIDE any lock (ADR 0013).
    // A Redis error is not a miss — both fall through to Postgres, but only a clean
    // miss may write back (an error could resurrect what an invalidation removed).
    const cacheRead = await this.presenceCache.get(dto.userId);
    const previousHint =
      cacheRead.status === 'hit' ? cacheRead.areaIds : await this.readPresenceUnlocked(dto.userId);

    // [3] The fork that carries the design (ADR 0011/0013): no apparent change →
    // acknowledge without a transaction, a lock, or a single write. Dedup state is
    // deliberately not consulted here — a no-change duplicate is absorbed by the
    // transition model itself; dedup remains authoritative on every WRITING path.
    if (!this.differs(currentAreaIds, previousHint)) {
      if (cacheRead.status === 'miss') {
        await this.presenceCache.populate(dto.userId, previousHint);
      }
      return { enteredAreaIds: [], duplicate: false };
    }

    // [4] Change path — everything below is the unchanged ADR 0002 transaction: the
    // hint got us here, but the diff that feeds writes is recomputed from the locked
    // authoritative read (hard constraint: no store but PostgreSQL decides a write).
    let wroteAnything = false;
    const result = await this.dataSource.transaction(
      async (manager: EntityManager): Promise<LocationReportResponseDto> => {
        const previousAreaIds = await this.lockAndReadPresence(manager, dto.userId);

        // Per-device dedup (ADR 0010), inside the transaction and under the lock — a
        // dedup check that could commit separately from the work it guards is not a
        // dedup check. seq is DEDUP ONLY — never treated as an ordering guarantee.
        if (dto.deviceId !== undefined && dto.seq !== undefined) {
          const stateRows = await manager.query<LastSeqRow[]>(
            `SELECT "last_seq" FROM "${USER_EVENT_STATE_TABLE}" WHERE "user_id" = $1 AND "device_id" = $2`,
            [dto.userId, dto.deviceId],
          );
          if (stateRows.length > 0 && dto.seq <= Number(stateRows[0].last_seq)) {
            return { enteredAreaIds: [], duplicate: true };
          }
          await manager.query(
            `INSERT INTO "${USER_EVENT_STATE_TABLE}" ("user_id", "device_id", "last_seq", "last_event_at")
             VALUES ($1, $2, $3, $4)
             ON CONFLICT ("user_id", "device_id") DO UPDATE SET "last_seq" = $3, "last_event_at" = $4`,
            [dto.userId, dto.deviceId, dto.seq, recordedAt],
          );
        }

        // Set difference against the AUTHORITATIVE read. A new user has previous = [],
        // so entered = current — decision 9 falls out with no special case.
        const previous = new Set(previousAreaIds);
        const current = new Set(currentAreaIds);
        const entered = currentAreaIds.filter((areaId) => !previous.has(areaId)).sort();
        const departed = previousAreaIds.filter((areaId) => !current.has(areaId));

        // Sorted order prevents deadlock between transactions touching overlapping
        // area sets. Log ONLY when the insert actually returns a row — the RETURNING
        // clause is the concurrency arbiter (ADR 0002), not application state.
        const enteredAreaIds: string[] = [];
        for (const areaId of entered) {
          const inserted = await manager.query<AreaIdRow[]>(
            `INSERT INTO "${PRESENCE_TABLE}" ("user_id", "area_id", "entered_at", "last_seen_at")
             VALUES ($1, $2, $3, $3)
             ON CONFLICT ("user_id", "area_id") DO NOTHING
             RETURNING "area_id"`,
            [dto.userId, areaId, recordedAt],
          );
          if (inserted.length > 0) {
            await manager.query(
              `INSERT INTO "${LOGS_TABLE}" ("user_id", "area_id", "recorded_at", "captured_at")
               VALUES ($1, $2, $3, $4)`,
              [dto.userId, areaId, recordedAt, capturedAt],
            );
            enteredAreaIds.push(areaId);
          }
        }

        // Exit maintenance — no log (non-goal). Without this delete,
        // exit-and-re-enter cannot work (acceptance scenario 4).
        if (departed.length > 0) {
          await manager.query(
            `DELETE FROM "${PRESENCE_TABLE}" WHERE "user_id" = $1 AND "area_id" = ANY($2)`,
            [dto.userId, departed],
          );
        }

        wroteAnything = enteredAreaIds.length > 0 || departed.length > 0;
        return { enteredAreaIds, duplicate: false };
      },
    );

    // A transaction the hint opened that the authoritative recompute emptied: the
    // trailing fingerprint of a possibly-suppressed visit (every lost visit ends in
    // one when its exit sample heals the stale key). UPPER BOUND, not a count —
    // read-aside races and stale-"changed" hits share the signature (ADR 0013).
    if (!result.duplicate && !wroteAnything) {
      this.presenceMetrics.recordChangePathNoop();
    }

    // [5] Invalidate AFTER commit, never update-in-place (ADR 0013). Runs on every
    // change-path exit including "authoritative said no change" — a stale-"changed"
    // key heals here instead of wasting a transaction per event until the TTL.
    // A failed DEL is counted QUALIFIED by whether this request's GET succeeded:
    // GET-ok + DEL-failed is the asymmetric flap that can suppress entries; a full
    // outage (GET also failing) is the safe case — reads fall through to Postgres.
    const invalidated = await this.presenceCache.invalidate(dto.userId);
    if (!invalidated) {
      this.presenceMetrics.recordInvalidateFailure(cacheRead.status !== 'error');
    }

    return result;
  }

  /** Plain read, no lock, no transaction — the hint source when the cache misses or errors. */
  private async readPresenceUnlocked(userId: string): Promise<string[]> {
    const rows = await this.dataSource.query<AreaIdRow[]>(
      `SELECT "area_id" FROM "${PRESENCE_TABLE}" WHERE "user_id" = $1`,
      [userId],
    );
    return rows.map((row) => row.area_id);
  }

  private differs(currentAreaIds: string[], previousAreaIds: string[]): boolean {
    if (currentAreaIds.length !== previousAreaIds.length) {
      return true;
    }
    const previous = new Set(previousAreaIds);
    return currentAreaIds.some((areaId) => !previous.has(areaId));
  }

  private async lockAndReadPresence(manager: EntityManager, userId: string): Promise<string[]> {
    const rows = await manager.query<AreaIdRow[]>(
      'SELECT "area_id" FROM lock_user_and_read_presence($1)',
      [userId],
    );
    return rows.map((row) => row.area_id);
  }
}
