import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { AreasService } from '@app/areas/areas.service';
import { PresenceCacheService } from '@app/presence/presence-cache.service';
import { appConfig } from '@config/app.config';
import { NodeEnvironment, PresenceReadStrategy } from '@config/config.constants';

import { LocationsService } from './locations.service';

describe('LocationsService', () => {
  let service: LocationsService;
  const findCoveringAreaIds = jest.fn();
  const managerQuery = jest.fn();
  const manager = { query: managerQuery } as unknown as EntityManager;
  const dataSourceMock = {
    transaction: jest.fn((callback: (m: EntityManager) => Promise<unknown>): Promise<unknown> =>
      callback(manager),
    ),
  };
  const cacheMock = {
    get: jest.fn(),
    populate: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
  const appConfigValue = {
    environment: NodeEnvironment.Test,
    port: 3000,
    presenceReadStrategy: PresenceReadStrategy.TwoStep,
  };

  const baseDto = { userId: 'user-1', lat: 41, lng: 29 };

  /** Presence-insert responses keyed by area id; everything else resolves []. */
  const primeQueries = (previous: string[], insertReturns: Record<string, boolean>): void => {
    managerQuery.mockImplementation((sql: string, params?: unknown[]): Promise<unknown[]> => {
      if (sql.includes('pg_advisory_xact_lock')) {
        return Promise.resolve([]);
      }
      if (sql.startsWith('SELECT "area_id"')) {
        return Promise.resolve(previous.map((areaId) => ({ area_id: areaId })));
      }
      if (sql.includes('ON CONFLICT')) {
        const areaId = (params as string[])[1];
        return Promise.resolve(insertReturns[areaId] ? [{ area_id: areaId }] : []);
      }
      return Promise.resolve([]);
    });
  };

  const callsMatching = (fragment: string): Array<[string, unknown[]]> =>
    (managerQuery.mock.calls as Array<[string, unknown[]]>).filter(([sql]) =>
      sql.includes(fragment),
    );

  beforeEach(async () => {
    jest.clearAllMocks();
    cacheMock.populate.mockResolvedValue(undefined);
    cacheMock.invalidate.mockResolvedValue(undefined);
    appConfigValue.presenceReadStrategy = PresenceReadStrategy.TwoStep;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationsService,
        { provide: AreasService, useValue: { findCoveringAreaIds } },
        { provide: getDataSourceToken(), useValue: dataSourceMock },
        { provide: appConfig.KEY, useValue: appConfigValue },
        { provide: PresenceCacheService, useValue: cacheMock },
      ],
    }).compile();

    service = module.get(LocationsService);
  });

  it('takes the advisory lock as the first statement in the transaction', async () => {
    findCoveringAreaIds.mockResolvedValue([]);
    primeQueries([], {});

    await service.report(baseDto);

    const firstSql = (managerQuery.mock.calls[0] as [string, unknown[]])[0];
    expect(firstSql).toContain('pg_advisory_xact_lock(hashtext($1))');
    expect((managerQuery.mock.calls[0] as [string, unknown[]])[1]).toEqual(['user-1']);
  });

  it('inserts entered areas in sorted order and logs each returned row', async () => {
    findCoveringAreaIds.mockResolvedValue(['bbb', 'aaa']);
    primeQueries([], { aaa: true, bbb: true });

    const result = await service.report(baseDto);

    const inserts = callsMatching('ON CONFLICT');
    expect(inserts.map(([, params]) => (params as string[])[1])).toEqual(['aaa', 'bbb']);
    expect(callsMatching('INSERT INTO "logs"')).toHaveLength(2);
    expect(result.enteredAreaIds).toEqual(['aaa', 'bbb']);
  });

  it('does NOT log when ON CONFLICT returns no row (a concurrent request won)', async () => {
    findCoveringAreaIds.mockResolvedValue(['aaa']);
    primeQueries([], { aaa: false });

    const result = await service.report(baseDto);

    expect(callsMatching('ON CONFLICT')).toHaveLength(1);
    expect(callsMatching('INSERT INTO "logs"')).toHaveLength(0);
    expect(result.enteredAreaIds).toEqual([]);
  });

  it('skips areas already present and deletes departed ones without logging', async () => {
    findCoveringAreaIds.mockResolvedValue(['stay', 'new']);
    primeQueries(['stay', 'gone'], { new: true });

    const result = await service.report(baseDto);

    expect(callsMatching('ON CONFLICT').map(([, params]) => (params as string[])[1])).toEqual([
      'new',
    ]);
    const deletes = callsMatching('DELETE FROM');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][1][1]).toEqual(['gone']);
    expect(callsMatching('INSERT INTO "logs"')).toHaveLength(1);
    expect(result.enteredAreaIds).toEqual(['new']);
  });

  it('passes one shared timestamp to presence and log inserts, and observedAt verbatim', async () => {
    findCoveringAreaIds.mockResolvedValue(['aaa']);
    primeQueries([], { aaa: true });

    await service.report({ ...baseDto, observedAt: '2020-01-01T00:00:00Z' });

    const [, presenceParams] = callsMatching('ON CONFLICT')[0];
    const [, logParams] = callsMatching('INSERT INTO "logs"')[0];
    const presenceTimestamp = presenceParams[2];
    expect(presenceTimestamp).toBeInstanceOf(Date);
    expect(logParams[2]).toBe(presenceTimestamp);
    expect(logParams[3]).toBe('2020-01-01T00:00:00Z');
  });

  it('makes no writes at all on a no-change request', async () => {
    findCoveringAreaIds.mockResolvedValue(['stay']);
    primeQueries(['stay'], {});

    const result = await service.report(baseDto);

    expect(callsMatching('ON CONFLICT')).toHaveLength(0);
    expect(callsMatching('DELETE FROM')).toHaveLength(0);
    expect(callsMatching('INSERT INTO "logs"')).toHaveLength(0);
    expect(result.enteredAreaIds).toEqual([]);
  });

  describe('folded strategy (Path A)', () => {
    beforeEach(() => {
      appConfigValue.presenceReadStrategy = PresenceReadStrategy.Folded;
    });

    it('uses one statement for lock+read and no separate lock call', async () => {
      findCoveringAreaIds.mockResolvedValue([]);
      managerQuery.mockImplementation((sql: string): Promise<unknown[]> =>
        Promise.resolve(sql.includes('lock_user_and_read_presence') ? [{ area_id: 'aaa' }] : []),
      );

      await service.report(baseDto);

      expect(callsMatching('lock_user_and_read_presence')).toHaveLength(1);
      expect(callsMatching('pg_advisory_xact_lock')).toHaveLength(0);
      expect(callsMatching('SELECT "area_id" FROM "user_area_presence"')).toHaveLength(0);
    });
  });

  describe('cache strategy (Path B)', () => {
    beforeEach(() => {
      appConfigValue.presenceReadStrategy = PresenceReadStrategy.Cache;
    });

    it('takes the lock BEFORE consulting the cache, and a hit skips the DB read', async () => {
      findCoveringAreaIds.mockResolvedValue(['stay']);
      primeQueries([], {});
      let lockTakenBeforeCacheRead = false;
      cacheMock.get.mockImplementation((): Promise<unknown> => {
        lockTakenBeforeCacheRead = callsMatching('pg_advisory_xact_lock').length === 1;
        return Promise.resolve({ status: 'hit', areaIds: ['stay'] });
      });

      const result = await service.report(baseDto);

      expect(lockTakenBeforeCacheRead).toBe(true);
      expect(callsMatching('SELECT "area_id" FROM "user_area_presence"')).toHaveLength(0);
      expect(cacheMock.populate).not.toHaveBeenCalled();
      expect(result.enteredAreaIds).toEqual([]);
    });

    it('on a miss reads the DB and populates; on error reads the DB and does NOT populate', async () => {
      findCoveringAreaIds.mockResolvedValue([]);
      primeQueries(['old-area'], {});

      cacheMock.get.mockResolvedValueOnce({ status: 'miss' });
      await service.report(baseDto);
      expect(cacheMock.populate).toHaveBeenCalledWith('user-1', ['old-area']);

      cacheMock.populate.mockClear();
      cacheMock.get.mockResolvedValueOnce({ status: 'error' });
      await service.report(baseDto);
      expect(callsMatching('SELECT "area_id" FROM "user_area_presence"')).toHaveLength(2);
      expect(cacheMock.populate).not.toHaveBeenCalled();
    });

    it('invalidates inside the transaction and again after commit when state changed', async () => {
      findCoveringAreaIds.mockResolvedValue(['new-area']);
      primeQueries([], { 'new-area': true });
      cacheMock.get.mockResolvedValue({ status: 'miss' });

      await service.report(baseDto);

      expect(cacheMock.invalidate).toHaveBeenCalledTimes(2);
      expect(cacheMock.invalidate).toHaveBeenCalledWith('user-1');
    });

    it('does not invalidate on a no-change request', async () => {
      findCoveringAreaIds.mockResolvedValue(['stay']);
      primeQueries([], {});
      cacheMock.get.mockResolvedValue({ status: 'hit', areaIds: ['stay'] });

      await service.report(baseDto);

      expect(cacheMock.invalidate).not.toHaveBeenCalled();
    });
  });
});
