import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { AreasService } from '@app/areas/areas.service';
import { PresenceCacheService } from '@app/presence/presence-cache.service';
import { PresenceMetricsService } from '@app/presence/presence-metrics.service';

import { LocationsService } from './locations.service';

describe('LocationsService', () => {
  let service: LocationsService;
  const findCoveringAreaIds = jest.fn();
  const managerQuery = jest.fn();
  const dataSourceQuery = jest.fn();
  const manager = { query: managerQuery } as unknown as EntityManager;
  const transaction = jest.fn(
    (callback: (m: EntityManager) => Promise<unknown>): Promise<unknown> => callback(manager),
  );
  const dataSourceMock = { transaction, query: dataSourceQuery };
  const cache = {
    get: jest.fn(),
    populate: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn().mockResolvedValue(true),
  };
  const metrics = {
    recordInvalidateFailure: jest.fn(),
    recordChangePathNoop: jest.fn(),
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

  /** The unlocked presence read used when the cache does not hit. */
  const primeUnlockedRead = (areaIds: string[]): void => {
    dataSourceQuery.mockResolvedValue(areaIds.map((areaId) => ({ area_id: areaId })));
  };

  const callsMatching = (fragment: string): Array<[string, unknown[]]> =>
    (managerQuery.mock.calls as Array<[string, unknown[]]>).filter(([sql]) =>
      sql.includes(fragment),
    );

  beforeEach(async () => {
    jest.clearAllMocks();
    cache.populate.mockResolvedValue(undefined);
    cache.invalidate.mockResolvedValue(true);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationsService,
        { provide: AreasService, useValue: { findCoveringAreaIds } },
        { provide: PresenceCacheService, useValue: cache },
        { provide: PresenceMetricsService, useValue: metrics },
        { provide: getDataSourceToken(), useValue: dataSourceMock },
      ],
    }).compile();

    service = module.get(LocationsService);
  });

  describe('the no-change fast path (ADR 0013)', () => {
    it('cache hit equal to current: returns without a transaction, a lock, or any write', async () => {
      findCoveringAreaIds.mockResolvedValue(['a']);
      cache.get.mockResolvedValue({ status: 'hit', areaIds: ['a'] });

      const result = await service.report(baseDto);

      expect(result).toEqual({ enteredAreaIds: [], duplicate: false });
      expect(transaction).not.toHaveBeenCalled();
      expect(dataSourceQuery).not.toHaveBeenCalled(); // not even the unlocked read
      expect(cache.populate).not.toHaveBeenCalled();
      expect(cache.invalidate).not.toHaveBeenCalled();
    });

    it('cached "[]" for a user in no areas is a real hit — second no-area report touches nothing', async () => {
      findCoveringAreaIds.mockResolvedValue([]);
      cache.get.mockResolvedValue({ status: 'hit', areaIds: [] });

      const result = await service.report(baseDto);

      expect(result.enteredAreaIds).toEqual([]);
      expect(transaction).not.toHaveBeenCalled();
      expect(dataSourceQuery).not.toHaveBeenCalled();
    });

    it('clean miss with no change: reads presence WITHOUT the lock and populates the cache', async () => {
      findCoveringAreaIds.mockResolvedValue(['a']);
      cache.get.mockResolvedValue({ status: 'miss' });
      primeUnlockedRead(['a']);

      const result = await service.report(baseDto);

      expect(result).toEqual({ enteredAreaIds: [], duplicate: false });
      expect(transaction).not.toHaveBeenCalled();
      const [sql, params] = dataSourceQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('user_area_presence');
      expect(sql).not.toContain('lock_user_and_read_presence');
      expect(params).toEqual(['user-1']);
      expect(cache.populate).toHaveBeenCalledWith('user-1', ['a']);
    });

    it('redis ERROR with no change: falls through to the DB but never writes back', async () => {
      findCoveringAreaIds.mockResolvedValue(['a']);
      cache.get.mockResolvedValue({ status: 'error' });
      primeUnlockedRead(['a']);

      await service.report(baseDto);

      expect(transaction).not.toHaveBeenCalled();
      expect(cache.populate).not.toHaveBeenCalled();
    });

    it('does NOT consult dedup state on the fast path — a no-change duplicate is absorbed, not labeled', async () => {
      findCoveringAreaIds.mockResolvedValue(['a']);
      cache.get.mockResolvedValue({ status: 'hit', areaIds: ['a'] });

      const result = await service.report({ ...baseDto, deviceId: 'phone-1', seq: 1 });

      expect(result).toEqual({ enteredAreaIds: [], duplicate: false });
      expect(transaction).not.toHaveBeenCalled();
      expect(managerQuery).not.toHaveBeenCalled();
    });
  });

  describe('the change path — cache gates, Postgres decides', () => {
    it('a stale cache saying "changed" wastes a transaction but writes NOTHING: the diff is recomputed under the lock', async () => {
      findCoveringAreaIds.mockResolvedValue(['a']);
      // Cache claims the user is outside; the authoritative locked read says inside.
      cache.get.mockResolvedValue({ status: 'hit', areaIds: [] });
      primeQueries(['a'], {});

      const result = await service.report(baseDto);

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(callsMatching('ON CONFLICT')).toHaveLength(0);
      expect(callsMatching('DELETE FROM')).toHaveLength(0);
      expect(callsMatching('INSERT INTO "logs"')).toHaveLength(0);
      expect(result.enteredAreaIds).toEqual([]);
      // The wasted transaction still heals the key.
      expect(cache.invalidate).toHaveBeenCalledWith('user-1');
      // …and leaves the trailing fingerprint: the upper-bound counter moves.
      expect(metrics.recordChangePathNoop).toHaveBeenCalledTimes(1);
    });

    it('does NOT count a writing transaction or a duplicate as a no-op', async () => {
      findCoveringAreaIds.mockResolvedValue(['aaa']);
      cache.get.mockResolvedValue({ status: 'miss' });
      primeUnlockedRead([]);
      primeQueries([], { aaa: true });
      await service.report(baseDto);
      expect(metrics.recordChangePathNoop).not.toHaveBeenCalled();

      jest.clearAllMocks();
      cache.invalidate.mockResolvedValue(true);
      findCoveringAreaIds.mockResolvedValue(['aaa']);
      cache.get.mockResolvedValue({ status: 'hit', areaIds: [] });
      primeQueries([], { aaa: true }, 5); // duplicate seq
      await service.report({ ...baseDto, deviceId: 'phone-1', seq: 5 });
      expect(metrics.recordChangePathNoop).not.toHaveBeenCalled();
    });

    it('counts a failed invalidation qualified by GET health: flap vs outage', async () => {
      // GET succeeded (hit), DEL failed → the asymmetric flap, the dangerous signal.
      findCoveringAreaIds.mockResolvedValue(['aaa']);
      cache.get.mockResolvedValue({ status: 'hit', areaIds: [] });
      cache.invalidate.mockResolvedValue(false);
      primeQueries([], { aaa: true });
      await service.report(baseDto);
      expect(metrics.recordInvalidateFailure).toHaveBeenCalledWith(true);

      jest.clearAllMocks();
      // GET also failed (error) → full outage, the safe case.
      findCoveringAreaIds.mockResolvedValue(['aaa']);
      cache.get.mockResolvedValue({ status: 'error' });
      cache.invalidate.mockResolvedValue(false);
      primeUnlockedRead([]);
      primeQueries([], { aaa: true });
      await service.report(baseDto);
      expect(metrics.recordInvalidateFailure).toHaveBeenCalledWith(false);
    });

    it('acquires lock and authoritative membership as the FIRST statement of the transaction', async () => {
      findCoveringAreaIds.mockResolvedValue(['a']);
      cache.get.mockResolvedValue({ status: 'hit', areaIds: [] });
      primeQueries([], { a: true });

      await service.report(baseDto);

      const firstSql = (managerQuery.mock.calls[0] as [string, unknown[]])[0];
      expect(firstSql).toContain('lock_user_and_read_presence($1)');
      expect((managerQuery.mock.calls[0] as [string, unknown[]])[1]).toEqual(['user-1']);
    });

    it('inserts entered areas in sorted order, logs each returned row, and invalidates after', async () => {
      findCoveringAreaIds.mockResolvedValue(['bbb', 'aaa']);
      cache.get.mockResolvedValue({ status: 'miss' });
      primeUnlockedRead([]);
      primeQueries([], { aaa: true, bbb: true });

      const result = await service.report(baseDto);

      const inserts = callsMatching('ON CONFLICT');
      expect(inserts.map(([, params]) => (params as string[])[1])).toEqual(['aaa', 'bbb']);
      expect(callsMatching('INSERT INTO "logs"')).toHaveLength(2);
      expect(result.enteredAreaIds).toEqual(['aaa', 'bbb']);
      expect(cache.invalidate).toHaveBeenCalledWith('user-1');
      expect(cache.populate).not.toHaveBeenCalled(); // change path never writes the cache
    });

    it('does NOT log when ON CONFLICT returns no row (a concurrent request won)', async () => {
      findCoveringAreaIds.mockResolvedValue(['aaa']);
      cache.get.mockResolvedValue({ status: 'miss' });
      primeUnlockedRead([]);
      primeQueries([], { aaa: false });

      const result = await service.report(baseDto);

      expect(callsMatching('ON CONFLICT')).toHaveLength(1);
      expect(callsMatching('INSERT INTO "logs"')).toHaveLength(0);
      expect(result.enteredAreaIds).toEqual([]);
    });

    it('skips areas already present and deletes departed ones without logging', async () => {
      findCoveringAreaIds.mockResolvedValue(['stay', 'new']);
      cache.get.mockResolvedValue({ status: 'hit', areaIds: ['stay', 'gone'] });
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
      cache.get.mockResolvedValue({ status: 'miss' });
      primeUnlockedRead([]);
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
      cache.get.mockResolvedValue({ status: 'miss' });
      primeUnlockedRead([]);
      primeQueries([], { aaa: true });
      await service.report({ ...baseDto, observedAt: '2019-01-01T00:00:00Z' });
      expect(callsMatching('INSERT INTO "logs"')[0][1][3]).toBe('2019-01-01T00:00:00Z');

      jest.clearAllMocks();
      findCoveringAreaIds.mockResolvedValue(['aaa']);
      cache.get.mockResolvedValue({ status: 'miss' });
      primeUnlockedRead([]);
      primeQueries([], { aaa: true });
      await service.report({
        ...baseDto,
        capturedAt: '2020-06-06T00:00:00Z',
        observedAt: '2019-01-01T00:00:00Z',
      });
      expect(callsMatching('INSERT INTO "logs"')[0][1][3]).toBe('2020-06-06T00:00:00Z');
    });
  });

  describe('per-device deduplication — authoritative on every writing path (ADR 0010 + 0013)', () => {
    const dedupDto = { ...baseDto, deviceId: 'phone-1', seq: 5 };

    it('a replayed seq that WOULD produce a change is stopped under the lock: duplicate, nothing written', async () => {
      findCoveringAreaIds.mockResolvedValue(['aaa']);
      cache.get.mockResolvedValue({ status: 'hit', areaIds: [] }); // diff exists → change path
      primeQueries([], { aaa: true }, 5); // last processed seq == incoming seq

      const result = await service.report(dedupDto);

      expect(result).toEqual({ enteredAreaIds: [], duplicate: true });
      expect(callsMatching('ON CONFLICT ("user_id", "area_id")')).toHaveLength(0);
      expect(callsMatching('INSERT INTO "logs"')).toHaveLength(0);
      expect(callsMatching('ON CONFLICT ("user_id", "device_id")')).toHaveLength(0);
    });

    it('processes a newer seq and records it in the same transaction', async () => {
      findCoveringAreaIds.mockResolvedValue(['aaa']);
      cache.get.mockResolvedValue({ status: 'miss' });
      primeUnlockedRead([]);
      primeQueries([], { aaa: true }, 4);

      const result = await service.report(dedupDto);

      expect(result.duplicate).toBe(false);
      expect(result.enteredAreaIds).toEqual(['aaa']);
      const upserts = callsMatching('ON CONFLICT ("user_id", "device_id")');
      expect(upserts).toHaveLength(1);
      expect(upserts[0][1].slice(0, 3)).toEqual(['user-1', 'phone-1', 5]);
    });

    it('skips dedup entirely for legacy requests without deviceId/seq', async () => {
      findCoveringAreaIds.mockResolvedValue(['aaa']);
      cache.get.mockResolvedValue({ status: 'miss' });
      primeUnlockedRead([]);
      primeQueries([], { aaa: true });

      await service.report(baseDto);

      expect(
        (managerQuery.mock.calls as Array<[string, unknown[]]>).filter(([sql]) =>
          sql.includes('user_event_state'),
        ),
      ).toHaveLength(0);
    });
  });

  it('rejects accuracy above the usable maximum with 422 before touching cache or database', async () => {
    await expect(service.report({ ...baseDto, accuracy: 150 })).rejects.toMatchObject({
      status: 422,
    });
    expect(findCoveringAreaIds).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(managerQuery).not.toHaveBeenCalled();
  });
});
