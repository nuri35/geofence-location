import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AreasService } from '@app/areas/areas.service';
import { LOGS_TABLE } from '@app/logs/entities/log.entity';
import { PresenceCacheService } from '@app/presence/presence-cache.service';
import { PRESENCE_TABLE } from '@app/presence/entities/presence.entity';
import { appConfig } from '@config/app.config';
import { PresenceReadStrategy } from '@config/config.constants';

import { LocationReportResponseDto, ReportLocationDto } from './dto';

interface AreaIdRow {
  area_id: string;
}

@Injectable()
export class LocationsService {
  constructor(
    private readonly areasService: AreasService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(appConfig.KEY) private readonly app: ConfigType<typeof appConfig>,
    private readonly presenceCache: PresenceCacheService,
  ) {}

  /**
   * The ADR 0002 transition path. Every write goes through the transaction's own
   * manager — never a normally injected repository (different connection, silently
   * outside the transaction) and never repository.save() (upsert-by-PK would UPDATE
   * an existing membership and defeat the ON CONFLICT arbiter).
   *
   * The presence read runs under one of three strategies (ADR 0007, measurement
   * scaffolding): 'two-step' baseline, 'folded' (lock+read in one round trip via a
   * plpgsql function), or 'cache' (Redis read-through in front of the read).
   */
  async report(dto: ReportLocationDto): Promise<LocationReportResponseDto> {
    // recorded_at is the server receive time (decision 8), captured once and passed
    // explicitly to both the presence row and its log row so they cannot disagree.
    const recordedAt = new Date();
    const strategy = this.app.presenceReadStrategy;

    // [1] Pure read, outside the transaction — must not extend the lock.
    const currentAreaIds = await this.areasService.findCoveringAreaIds(dto.lng, dto.lat);

    let stateChanged = false;
    const result = await this.dataSource.transaction(
      async (manager: EntityManager): Promise<LocationReportResponseDto> => {
        // [2]+[3] Lock FIRST, then previous membership. The lock must be held before
        // any presence source is consulted — including the cache: a cache value read
        // before the lock can already have been invalidated by a concurrent request,
        // and on the exit side there is no ON CONFLICT to catch the mistake (ADR 0002).
        const previousAreaIds = await this.lockAndReadPrevious(manager, dto.userId, strategy);

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

        stateChanged = enteredAreaIds.length > 0 || departed.length > 0;
        if (strategy === PresenceReadStrategy.Cache && stateChanged) {
          // Inside the transaction, still under the lock: the next same-user request
          // (queued on the lock) must not see the stale cached set.
          await this.presenceCache.invalidate(dto.userId);
        }

        return { enteredAreaIds };
      },
    );

    if (strategy === PresenceReadStrategy.Cache && stateChanged) {
      // Belt-and-braces after commit, failures swallowed: a cache left empty after a
      // rollback is harmless — the next read misses and goes to the database.
      await this.presenceCache.invalidate(dto.userId);
    }

    return result;
  }

  private async lockAndReadPrevious(
    manager: EntityManager,
    userId: string,
    strategy: PresenceReadStrategy,
  ): Promise<string[]> {
    if (strategy === PresenceReadStrategy.Folded) {
      // Path A: one round trip. Ordering is guaranteed by plpgsql sequential execution
      // (see migration CreateLockedPresenceReadFunction), not by planner behaviour.
      const rows = await manager.query<AreaIdRow[]>(
        'SELECT "area_id" FROM lock_user_and_read_presence($1)',
        [userId],
      );
      return rows.map((row) => row.area_id);
    }

    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);

    if (strategy === PresenceReadStrategy.Cache) {
      // Path B: read-through cache, consulted only under the lock.
      const cached = await this.presenceCache.get(userId);
      if (cached.status === 'hit') {
        return cached.areaIds;
      }
      const fromDatabase = await this.readPresence(manager, userId);
      if (cached.status === 'miss') {
        // Only a clean miss may write back — after an error we cannot know whether a
        // concurrent invalidation just removed a value we would be resurrecting.
        await this.presenceCache.populate(userId, fromDatabase);
      }
      return fromDatabase;
    }

    return this.readPresence(manager, userId);
  }

  private async readPresence(manager: EntityManager, userId: string): Promise<string[]> {
    const rows = await manager.query<AreaIdRow[]>(
      `SELECT "area_id" FROM "${PRESENCE_TABLE}" WHERE "user_id" = $1`,
      [userId],
    );
    return rows.map((row) => row.area_id);
  }
}
