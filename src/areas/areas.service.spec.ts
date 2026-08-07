import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Polygon } from 'geojson';

import { AreasService } from './areas.service';
import { CreateAreaDto } from './dto';
import { AreaEntity } from './entities/area.entity';

const squareBoundary: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  ],
};

describe('AreasService', () => {
  let service: AreasService;
  const managerQuery = jest.fn();
  const repositoryMock = {
    manager: { query: managerQuery },
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AreasService,
        { provide: getRepositoryToken(AreaEntity), useValue: repositoryMock },
      ],
    }).compile();

    service = module.get(AreasService);
  });

  describe('create', () => {
    const dto: CreateAreaDto = { name: 'test', boundary: squareBoundary };

    it('rejects an ST_IsValid failure with 400 carrying the reason, before any save', async () => {
      managerQuery.mockResolvedValue([{ valid: false, reason: 'Self-intersection[5 5]' }]);

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
      await expect(service.create(dto)).rejects.toThrow('Self-intersection[5 5]');
      expect(repositoryMock.save).not.toHaveBeenCalled();
    });

    it('saves when ST_IsValid passes', async () => {
      managerQuery.mockResolvedValueOnce([{ valid: true, reason: null }]);
      const entity = { id: 'uuid-1' } as AreaEntity;
      repositoryMock.create.mockReturnValueOnce(entity);
      repositoryMock.save.mockResolvedValueOnce(entity);

      await expect(service.create(dto)).resolves.toBe(entity);
      expect(repositoryMock.create).toHaveBeenCalledWith({
        name: 'test',
        boundary: squareBoundary,
      });
    });
  });

  describe('findCoveringAreaIds', () => {
    it('passes [lng, lat] in that order and returns bare ids', async () => {
      managerQuery.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);

      await expect(service.findCoveringAreaIds(28.98, 41.01)).resolves.toEqual(['a', 'b']);

      const [sql, params] = managerQuery.mock.calls[0] as [string, number[]];
      expect(sql).toContain('ST_Covers');
      expect(sql).toContain('ST_SetSRID(ST_MakePoint($1, $2), 4326)');
      expect(sql).not.toContain('ST_Contains');
      expect(params).toEqual([28.98, 41.01]);
    });
  });

  describe('findAll', () => {
    it('applies limit and offset as take and skip', async () => {
      repositoryMock.find.mockResolvedValueOnce([]);

      await service.findAll({ limit: 10, offset: 20 });

      expect(repositoryMock.find).toHaveBeenCalledWith({
        order: { createdAt: 'ASC', id: 'ASC' },
        take: 10,
        skip: 20,
      });
    });
  });
});
