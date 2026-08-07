import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AreasService } from '@app/areas/areas.service';
import { LOGS_TABLE } from '@app/logs/entities/log.entity';
import { PRESENCE_TABLE } from '@app/presence/entities/presence.entity';

import { LocationReportResponseDto, ReportLocationDto } from './dto';

interface AreaIdRow {
  area_id: string;
}

@Injectable()
export class LocationsService {
  constructor(
    private readonly areasService: AreasService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * The ADR 0002 transition path. Every write goes through the transaction's own
   * manager — never a normally injected repository (different connection, silently
   * outside the transaction) and never repository.save() (upsert-by-PK would UPDATE
   * an existing membership and defeat the ON CONFLICT arbiter).
   */
  async report(dto: ReportLocationDto): Promise<LocationReportResponseDto> {
    // recorded_at is the server receive time (decision 8), captured once and passed
    // explicitly to both the presence row and its log row so they cannot disagree.
    const recordedAt = new Date();

    // [1] Pure read, outside the transaction — must not extend the lock.
    const currentAreaIds = await this.areasService.findCoveringAreaIds(dto.lng, dto.lat);

    return this.dataSource.transaction(
      async (manager: EntityManager): Promise<LocationReportResponseDto> => {
        // [2] First statement: serialize same-user requests. Transaction-scoped —
        // releases on COMMIT/ROLLBACK, no manual unlock.
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [dto.userId]);

        // [3] Previous membership. Phase 3 puts its cache in front of this call — one seam.
        const previousAreaIds = await this.readPresence(manager, dto.userId);

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
              `INSERT INTO "${LOGS_TABLE}" ("user_id", "area_id", "recorded_at", "observed_at")
             VALUES ($1, $2, $3, $4)`,
              [dto.userId, areaId, recordedAt, dto.observedAt ?? null],
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

        return { enteredAreaIds };
      },
    );
  }

  private async readPresence(manager: EntityManager, userId: string): Promise<string[]> {
    const rows = await manager.query<AreaIdRow[]>(
      `SELECT "area_id" FROM "${PRESENCE_TABLE}" WHERE "user_id" = $1`,
      [userId],
    );
    return rows.map((row) => row.area_id);
  }
}
