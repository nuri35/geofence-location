import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AreasService } from '@app/areas/areas.service';
import { LOGS_TABLE } from '@app/logs/entities/log.entity';
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
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * The ADR 0002 transition path plus the ADR 0010 payload contract. Every write goes
   * through the transaction's own manager — never a normally injected repository
   * (different connection, silently outside the transaction) and never
   * repository.save() (upsert-by-PK would UPDATE an existing membership and defeat
   * the ON CONFLICT arbiter).
   */
  async report(dto: ReportLocationDto): Promise<LocationReportResponseDto> {
    // ADR 0010: semantic gate, deliberately 422 not 400 — the request is well-formed;
    // a reading with this error radius just cannot answer "inside or outside".
    if (dto.accuracy !== undefined && dto.accuracy > MAX_ACCURACY_METERS) {
      throw new UnprocessableEntityException(
        `accuracy ${dto.accuracy}m exceeds the usable maximum of ${MAX_ACCURACY_METERS}m: a reading this uncertain cannot be checked against area boundaries`,
      );
    }

    // recorded_at is the server receive time (decision 8), captured once and passed
    // explicitly to both the presence row and its log row so they cannot disagree.
    const recordedAt = new Date();
    // ADR 0010: capturedAt replaces observedAt; the deprecated alias is honored for
    // pre-contract clients, capturedAt winning when both are sent.
    const capturedAt = dto.capturedAt ?? dto.observedAt ?? null;

    // [1] Pure read, outside the transaction — must not extend the lock.
    const currentAreaIds = await this.areasService.findCoveringAreaIds(dto.lng, dto.lat);

    return this.dataSource.transaction(
      async (manager: EntityManager): Promise<LocationReportResponseDto> => {
        // [2]+[3] Advisory lock + previous membership in ONE round trip (ADR 0007).
        // The plpgsql body guarantees the lock is acquired BEFORE the read.
        const previousAreaIds = await this.lockAndReadPresence(manager, dto.userId);

        // [2b] Per-device dedup (ADR 0010), inside the same transaction and under the
        // same lock — a dedup check that could commit separately from the work it
        // guards is not a dedup check. Runs for every request carrying (deviceId, seq),
        // including the ~99% that change nothing: a duplicate no-op is acknowledged
        // without reprocessing, so the semantics stay deliberate rather than accidental.
        // seq is DEDUP ONLY — never treated as an ordering guarantee.
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

        // [4] Set difference. A new user has previous = [], so entered = current —
        // decision 9 falls out with no special case.
        const previous = new Set(previousAreaIds);
        const current = new Set(currentAreaIds);
        const entered = currentAreaIds.filter((areaId) => !previous.has(areaId)).sort();
        const departed = previousAreaIds.filter((areaId) => !current.has(areaId));

        // [5] Sorted order prevents deadlock between transactions touching overlapping
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

        // [6] Exit maintenance — no log (non-goal). Without this delete,
        // exit-and-re-enter cannot work (acceptance scenario 4).
        if (departed.length > 0) {
          await manager.query(
            `DELETE FROM "${PRESENCE_TABLE}" WHERE "user_id" = $1 AND "area_id" = ANY($2)`,
            [dto.userId, departed],
          );
        }

        return { enteredAreaIds, duplicate: false };
      },
    );
  }

  private async lockAndReadPresence(manager: EntityManager, userId: string): Promise<string[]> {
    const rows = await manager.query<AreaIdRow[]>(
      'SELECT "area_id" FROM lock_user_and_read_presence($1)',
      [userId],
    );
    return rows.map((row) => row.area_id);
  }
}
