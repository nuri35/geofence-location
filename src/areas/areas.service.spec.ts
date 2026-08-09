import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Polygon } from 'geojson';
import { EntityManager } from 'typeorm';

import { AreaSnapshotService } from './area-snapshot.service';
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
  const txnQuery = jest.fn();
  const txnSave = jest.fn();
  const txnManager = { query: txnQuery, save: txnSave } as unknown as EntityManager;
  const transaction = jest.fn(
    (callback: (m: EntityManager) => Promise<unknown>): Promise<unknown> => callback(txnManager),
  );
  const repositoryMock = {
    manager: { query: managerQuery, transaction },
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
  };
  const snapshotMock = {
    findCoveringAreaIds: jest.fn(),
    refreshNow: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AreasService,
        { provide: getRepositoryToken(AreaEntity), useValue: repositoryMock },
        { provide: AreaSnapshotService, useValue: snapshotMock },
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
      expect(transaction).not.toHaveBeenCalled();
      expect(snapshotMock.refreshNow).not.toHaveBeenCalled();
    });

    it('saves and bumps area_version in ONE transaction when ST_IsValid passes', async () => {
      managerQuery.mockResolvedValueOnce([{ valid: true, reason: null }]);
      const entity = { id: 'uuid-1' } as AreaEntity;
      repositoryMock.create.mockReturnValueOnce(entity);
      txnSave.mockResolvedValueOnce(entity);
      txnQuery.mockResolvedValueOnce([]);
      snapshotMock.refreshNow.mockResolvedValueOnce(undefined);

      await expect(service.create(dto)).resolves.toBe(entity);

      expect(repositoryMock.create).toHaveBeenCalledWith({
        name: 'test',
        boundary: squareBoundary,
      });
      expect(txnSave).toHaveBeenCalledWith(entity);
      const bumpSql = (txnQuery.mock.calls[0] as [string])[0];
      expect(bumpSql).toContain('UPDATE "area_version"');
      expect(bumpSql).toContain('"version" = "version" + 1');
      // The direct repository (non-transactional) save path must be gone.
      expect(repositoryMock.save).not.toHaveBeenCalled();
    });

    it('refreshes the local snapshot after the transaction commits', async () => {
      managerQuery.mockResolvedValueOnce([{ valid: true, reason: null }]);
      const entity = { id: 'uuid-1' } as AreaEntity;
      repositoryMock.create.mockReturnValueOnce(entity);
      txnSave.mockResolvedValueOnce(entity);
      txnQuery.mockResolvedValueOnce([]);
      snapshotMock.refreshNow.mockResolvedValueOnce(undefined);

      await service.create(dto);

      expect(snapshotMock.refreshNow).toHaveBeenCalledTimes(1);
      // Ordering: the refresh happens after the transaction callback resolved.
      const txnOrder = transaction.mock.invocationCallOrder[0];
      const refreshOrder = snapshotMock.refreshNow.mock.invocationCallOrder[0];
      expect(refreshOrder).toBeGreaterThan(txnOrder);
    });
  });

  describe('findCoveringAreaIds', () => {
    it('delegates to the in-memory snapshot — no SQL on the hot path', async () => {
      snapshotMock.findCoveringAreaIds.mockReturnValueOnce(['a', 'b']);

      await expect(service.findCoveringAreaIds(28.98, 41.01)).resolves.toEqual(['a', 'b']);

      expect(snapshotMock.findCoveringAreaIds).toHaveBeenCalledWith(28.98, 41.01);
      expect(managerQuery).not.toHaveBeenCalled();
    });
  });

  describe('findCoveringAreaIdsViaPostgis (equivalence reference, off the hot path)', () => {
    it('passes [lng, lat] in that order and returns bare ids', async () => {
      managerQuery.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);

      await expect(service.findCoveringAreaIdsViaPostgis(28.98, 41.01)).resolves.toEqual([
        'a',
        'b',
      ]);

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
