import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { Polygon } from 'geojson';
import { DataSource } from 'typeorm';

import { areasConfig } from '@config/areas.config';

import { AREA_VERSION_TABLE, AREAS_TABLE } from './areas.constants';
import { AreaSpatialIndex } from './spatial-index';

interface VersionRow {
  version: string;
}

interface BoundaryRow {
  id: string;
  boundary: Polygon;
}

interface Snapshot {
  version: string;
  index: AreaSpatialIndex;
}

/**
 * The versioned in-memory polygon snapshot (ADR 0012): built from Postgres at
 * bootstrap, rebuilt when the polled area_version moves or POST /areas asks for it,
 * swapped as one reference so no request ever sees a half-built index. PostGIS
 * remains the source of truth for geometry — this is a read-only projection of it.
 */
@Injectable()
export class AreaSnapshotService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AreaSnapshotService.name);
  private snapshot: Snapshot | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  // Rebuilds are serialized through this chain: a slow older build can never
  // overwrite a newer one, and a refreshNow() enqueued behind an in-flight rebuild
  // is guaranteed to read data committed before the call.
  private rebuildChain: Promise<void> = Promise.resolve();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(areasConfig.KEY) private readonly config: ConfigType<typeof areasConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // A failed FIRST build aborts boot: with no index the service would answer
    // "nothing covers anything" — wrong answers, not stale ones. Runtime rebuild
    // failures keep the last good index instead (see poll()).
    await this.enqueueRebuild();
    this.pollTimer = setInterval(() => void this.poll(), this.config.pollIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  findCoveringAreaIds(lng: number, lat: number): string[] {
    if (this.snapshot === null) {
      throw new Error('area snapshot not built — bootstrap has not completed');
    }
    return this.snapshot.index.findCoveringAreaIds(lng, lat);
  }

  /** POST /areas awaits this after commit: the creating instance never waits a poll. */
  refreshNow(): Promise<void> {
    return this.enqueueRebuild();
  }

  private async poll(): Promise<void> {
    try {
      const rows = await this.dataSource.query<VersionRow[]>(
        `SELECT "version"::text AS "version" FROM "${AREA_VERSION_TABLE}"`,
      );
      if (this.snapshot === null || rows[0].version !== this.snapshot.version) {
        await this.enqueueRebuild();
      }
    } catch (error) {
      // Stale-not-dead: polygons are near-static and the hot path no longer touches
      // the database — a transient failure keeps the last good index and the next
      // tick retries. Only staleness is bounded here, never availability.
      this.logger.warn(`area version poll failed; serving stale snapshot: ${String(error)}`);
    }
  }

  private enqueueRebuild(): Promise<void> {
    const next = this.rebuildChain.then(() => this.rebuild());
    this.rebuildChain = next.catch(() => undefined);
    return next;
  }

  private async rebuild(): Promise<void> {
    const startedAt = process.hrtime.bigint();
    // Version FIRST, then rows: an area committed in between leaves the snapshot
    // labeled older than its data, and the next poll harmlessly rebuilds. The
    // opposite order would label it newer and silently miss a real change.
    const versionRows = await this.dataSource.query<VersionRow[]>(
      `SELECT "version"::text AS "version" FROM "${AREA_VERSION_TABLE}"`,
    );
    const areaRows = await this.dataSource.query<BoundaryRow[]>(
      `SELECT "id", ST_AsGeoJSON("boundary")::json AS "boundary" FROM "${AREAS_TABLE}"`,
    );
    const index = new AreaSpatialIndex(areaRows);
    // Single reference assignment — atomic from any request's point of view.
    this.snapshot = { version: versionRows[0].version, index };
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    this.logger.log(
      `area snapshot v${versionRows[0].version}: ${index.areaCount} areas indexed in ${elapsedMs.toFixed(1)}ms`,
    );
  }
}
