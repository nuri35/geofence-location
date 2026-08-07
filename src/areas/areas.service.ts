import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AREAS_TABLE } from './areas.constants';
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
    const area = this.areasRepository.create({ name: dto.name, boundary: dto.boundary });
    return this.areasRepository.save(area);
  }

  findAll(query: ListAreasQueryDto): Promise<AreaEntity[]> {
    return this.areasRepository.find({
      order: { createdAt: 'ASC', id: 'ASC' },
      take: query.limit,
      skip: query.offset,
    });
  }

  /**
   * "Which areas contain this point" — the Phase 2 hot path, isolated here per the phase plan.
   * Raw SQL: TypeORM does not transform spatial parameters in .where() (postgis-spatial §4).
   * ST_Covers, not ST_Contains: the boundary counts as inside (decision 2, ADR 0003).
   * Returns ids only — no geometry leaves the database on this path.
   */
  async findCoveringAreaIds(lng: number, lat: number): Promise<string[]> {
    const rows = await this.areasRepository.manager.query<AreaIdRow[]>(
      `SELECT "id" FROM "${AREAS_TABLE}" WHERE ST_Covers("boundary", ST_SetSRID(ST_MakePoint($1, $2), 4326))`,
      [lng, lat],
    );
    return rows.map((row) => row.id);
  }
}
