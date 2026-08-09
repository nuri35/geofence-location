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
  const primeQueries = (
    previous: string[],
    insertReturns: Record<string, boolean>,
    lastSeq: number | null = null,
  ): void => {
    managerQuery.mockImplementation((sql: string, params?: unknown[]): Promise<unknown[]> => {
      if (sql.includes('lock_user_and_read_presence')) {
        return Promise.resolve(previous.map((areaId) => ({ area_id: areaId })));
      }
      if (sql.includes('user_event_state') && sql.startsWith('SELECT')) {
        return Promise.resolve(lastSeq === null ? [] : [{ last_seq: String(lastSeq) }]);
      }
      if (sql.includes(`ON CONFLICT ("user_id", "area_id")`)) {
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

  it('acquires lock and previous membership in one statement, as the first statement', async () => {
    findCoveringAreaIds.mockResolvedValue([]);
    primeQueries([], {});

    await service.report(baseDto);

    const firstSql = (managerQuery.mock.calls[0] as [string, unknown[]])[0];
    expect(firstSql).toContain('lock_user_and_read_presence($1)');
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

  it('passes one shared timestamp to presence and log inserts, and capturedAt verbatim', async () => {
    findCoveringAreaIds.mockResolvedValue(['aaa']);
    primeQueries([], { aaa: true });

    await service.report({ ...baseDto, capturedAt: '2020-01-01T00:00:00Z' });

    const [, presenceParams] = callsMatching('ON CONFLICT ("user_id", "area_id")')[0];
    const [, logParams] = callsMatching('INSERT INTO "logs"')[0];
    const presenceTimestamp = presenceParams[2];
    expect(presenceTimestamp).toBeInstanceOf(Date);
    expect(logParams[2]).toBe(presenceTimestamp);
    expect(logParams[3]).toBe('2020-01-01T00:00:00Z');
  });

  it('honors the deprecated observedAt alias, with capturedAt winning when both are sent', async () => {
    findCoveringAreaIds.mockResolvedValue(['aaa']);
    primeQueries([], { aaa: true });
    await service.report({ ...baseDto, observedAt: '2019-01-01T00:00:00Z' });
    expect(callsMatching('INSERT INTO "logs"')[0][1][3]).toBe('2019-01-01T00:00:00Z');

    jest.clearAllMocks();
    findCoveringAreaIds.mockResolvedValue(['aaa']);
    primeQueries([], { aaa: true });
    await service.report({
      ...baseDto,
      capturedAt: '2020-06-06T00:00:00Z',
      observedAt: '2019-01-01T00:00:00Z',
    });
    expect(callsMatching('INSERT INTO "logs"')[0][1][3]).toBe('2020-06-06T00:00:00Z');
  });

  describe('per-device deduplication (ADR 0010)', () => {
    const dedupDto = { ...baseDto, deviceId: 'phone-1', seq: 5 };

    it('acknowledges a non-newer seq as duplicate without any processing', async () => {
      findCoveringAreaIds.mockResolvedValue(['aaa']);
      primeQueries([], { aaa: true }, 5); // last processed seq == incoming seq

      const result = await service.report(dedupDto);

      expect(result).toEqual({ enteredAreaIds: [], duplicate: true });
      expect(callsMatching('ON CONFLICT ("user_id", "area_id")')).toHaveLength(0);
      expect(callsMatching('INSERT INTO "logs"')).toHaveLength(0);
      expect(callsMatching('ON CONFLICT ("user_id", "device_id")')).toHaveLength(0);
    });

    it('processes a newer seq and records it in the same transaction', async () => {
      findCoveringAreaIds.mockResolvedValue(['aaa']);
      primeQueries([], { aaa: true }, 4);

      const result = await service.report(dedupDto);

      expect(result.duplicate).toBe(false);
      expect(result.enteredAreaIds).toEqual(['aaa']);
      const upserts = callsMatching('ON CONFLICT ("user_id", "device_id")');
      expect(upserts).toHaveLength(1);
      expect(upserts[0][1].slice(0, 3)).toEqual(['user-1', 'phone-1', 5]);
    });

    it('keys dedup state by device — the SELECT carries both userId and deviceId', async () => {
      findCoveringAreaIds.mockResolvedValue([]);
      primeQueries([], {}, null);

      await service.report({ ...baseDto, deviceId: 'tablet-2', seq: 1 });

      const stateSelects = (managerQuery.mock.calls as Array<[string, unknown[]]>).filter(
        ([sql]) => sql.includes('user_event_state') && sql.startsWith('SELECT'),
      );
      expect(stateSelects[0][1]).toEqual(['user-1', 'tablet-2']);
    });

    it('skips dedup entirely for legacy requests without deviceId/seq', async () => {
      findCoveringAreaIds.mockResolvedValue([]);
      primeQueries([], {});

      await service.report(baseDto);

      expect(
        (managerQuery.mock.calls as Array<[string, unknown[]]>).filter(([sql]) =>
          sql.includes('user_event_state'),
        ),
      ).toHaveLength(0);
    });
  });

  it('rejects accuracy above the usable maximum with 422 before touching the database', async () => {
    await expect(service.report({ ...baseDto, accuracy: 150 })).rejects.toMatchObject({
      status: 422,
    });
    expect(findCoveringAreaIds).not.toHaveBeenCalled();
    expect(managerQuery).not.toHaveBeenCalled();
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
