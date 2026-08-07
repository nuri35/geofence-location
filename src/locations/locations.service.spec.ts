import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { AreasService } from '@app/areas/areas.service';

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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationsService,
        { provide: AreasService, useValue: { findCoveringAreaIds } },
        { provide: getDataSourceToken(), useValue: dataSourceMock },
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
});
