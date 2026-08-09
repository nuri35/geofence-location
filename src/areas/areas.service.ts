import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { AreaSnapshotService } from './area-snapshot.service';
import { AREA_VERSION_TABLE, AREAS_TABLE } from './areas.constants';
import { CreateAreaDto, ListAreasQueryDto } from './dto';
import { AreaEntity } from './entities/area.entity';

interface GeometryValidityRow {
  valid: boolean;
  reason: string | null;
}

interface AreaIdRow {
  id: string;
}

@Injectable()
export class AreasService {
  constructor(
    @InjectRepository(AreaEntity)
    private readonly areasRepository: Repository<AreaEntity>,
    private readonly snapshotService: AreaSnapshotService,
  ) {}

  async create(dto: CreateAreaDto): Promise<AreaEntity> {
    // ST_IsValid gate before the row is written (CLAUDE.md hard constraint). The DTO has
    // already guaranteed structure (closed rings, ranges), so ST_GeomFromGeoJSON cannot throw
    // on shape; what remains is geometric validity, which only PostGIS can judge.
    const rows = await this.areasRepository.manager.query<GeometryValidityRow[]>(
      'SELECT ST_IsValid(g) AS valid, ST_IsValidReason(g) AS reason FROM (SELECT ST_GeomFromGeoJSON($1) AS g) AS s',
      [JSON.stringify(dto.boundary)],
    );
    const validity = rows[0];
    if (!validity.valid) {
      throw new BadRequestException(`invalid polygon: ${validity.reason ?? 'unknown reason'}`);
    }
    const area = await this.areasRepository.manager.transaction(
      async (manager: EntityManager): Promise<AreaEntity> => {
        const saved = await manager.save(
          this.areasRepository.create({ name: dto.name, boundary: dto.boundary }),
        );
        // Same transaction as the insert (ADR 0012): no observer can ever read a
        // version that runs ahead of or behind the areas it describes.
        await manager.query(`UPDATE "${AREA_VERSION_TABLE}" SET "version" = "version" + 1`);
        return saved;
      },
    );
    // After commit: the creating instance takes effect immediately; other instances
    // catch up via the version poll (bounded by AREAS_POLL_INTERVAL_MS).
    await this.snapshotService.refreshNow();
    return area;
  }

  findAll(query: ListAreasQueryDto): Promise<AreaEntity[]> {
    return this.areasRepository.find({
      order: { createdAt: 'ASC', id: 'ASC' },
      take: query.limit,
      skip: query.offset,
    });
  }

  /**
   * "Which areas contain this point" — the hot path. Since Phase N2 (ADR 0012) this
   * is answered by the in-memory snapshot: rbush bbox prefilter + turf containment
   * reproducing ST_Covers boundary semantics, proven equivalent by
   * test/spatial-equivalence.e2e-spec.ts. The Promise signature is kept so callers
   * (LocationsService) are untouched. Returns ids only, like the query it replaced.
   */
  findCoveringAreaIds(lng: number, lat: number): Promise<string[]> {
    return Promise.resolve(this.snapshotService.findCoveringAreaIds(lng, lat));
  }

  /**
   * The pre-N2 PostGIS query, kept OFF the hot path as the reference implementation:
   * the spatial-equivalence e2e harness runs every probe point through both this and
   * the in-memory index and asserts identical answers — the tripwire for a turf or
   * PostGIS upgrade changing boundary behaviour.
   * Raw SQL: TypeORM does not transform spatial parameters in .where() (postgis-spatial §4).
   * ST_Covers, not ST_Contains: the boundary counts as inside (decision 2, ADR 0003).
   */
  async findCoveringAreaIdsViaPostgis(lng: number, lat: number): Promise<string[]> {
    const rows = await this.areasRepository.manager.query<AreaIdRow[]>(
      `SELECT "id" FROM "${AREAS_TABLE}" WHERE ST_Covers("boundary", ST_SetSRID(ST_MakePoint($1, $2), 4326))`,
      [lng, lat],
    );
    return rows.map((row) => row.id);
  }
}
