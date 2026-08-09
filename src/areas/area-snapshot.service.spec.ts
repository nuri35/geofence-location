import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Polygon } from 'geojson';

import { areasConfig } from '@config/areas.config';

import { AreaSnapshotService } from './area-snapshot.service';

const square = (lngBase: number, latBase: number, size: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [lngBase, latBase],
      [lngBase + size, latBase],
      [lngBase + size, latBase + size],
      [lngBase, latBase + size],
      [lngBase, latBase],
    ],
  ],
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

const POLL_MS = 1_000;

describe('AreaSnapshotService', () => {
  let service: AreaSnapshotService;
  let warnSpy: jest.SpyInstance;
  let currentVersion: string;
  let areasImpl: () => Promise<Array<{ id: string; boundary: Polygon }>>;
  const query = jest.fn();

  const areasQueryCalls = (): number =>
    (query.mock.calls as Array<[string]>).filter(([sql]) => sql.includes('FROM "areas"')).length;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    currentVersion = '1';
    areasImpl = (): Promise<Array<{ id: string; boundary: Polygon }>> =>
      Promise.resolve([{ id: 'a', boundary: square(0, 0, 10) }]);
    query.mockImplementation((sql: string): Promise<unknown[]> => {
      if (sql.includes('area_version')) {
        return Promise.resolve([{ version: currentVersion }]);
      }
      return areasImpl();
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AreaSnapshotService,
        { provide: getDataSourceToken(), useValue: { query } },
        { provide: areasConfig.KEY, useValue: { pollIntervalMs: POLL_MS } },
      ],
    }).compile();

    service = module.get(AreaSnapshotService);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('builds the index at bootstrap and answers from it', async () => {
    await service.onApplicationBootstrap();
    expect(service.findCoveringAreaIds(5, 5)).toEqual(['a']);
    expect(service.findCoveringAreaIds(50, 50)).toEqual([]);
  });

  it('throws before the first build has completed', () => {
    expect(() => service.findCoveringAreaIds(5, 5)).toThrow('snapshot not built');
  });

  it('rejects bootstrap when the first build fails — boot must abort, not serve empty', async () => {
    areasImpl = (): Promise<Array<{ id: string; boundary: Polygon }>> =>
      Promise.reject(new Error('db down'));
    await expect(service.onApplicationBootstrap()).rejects.toThrow('db down');
  });

  it('does not rebuild when the polled version is unchanged', async () => {
    jest.useFakeTimers();
    await service.onApplicationBootstrap();
    expect(areasQueryCalls()).toBe(1);

    await jest.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(areasQueryCalls()).toBe(1); // version was checked, areas never re-read
  });

  it('rebuilds when the polled version moved', async () => {
    jest.useFakeTimers();
    await service.onApplicationBootstrap();
    currentVersion = '2';
    areasImpl = (): Promise<Array<{ id: string; boundary: Polygon }>> =>
      Promise.resolve([{ id: 'b', boundary: square(20, 20, 10) }]);

    await jest.advanceTimersByTimeAsync(POLL_MS);

    expect(areasQueryCalls()).toBe(2);
    expect(service.findCoveringAreaIds(25, 25)).toEqual(['b']);
    expect(service.findCoveringAreaIds(5, 5)).toEqual([]);
  });

  it('keeps serving the old index while a rebuild is in flight (atomic swap)', async () => {
    await service.onApplicationBootstrap();
    const pending = deferred<Array<{ id: string; boundary: Polygon }>>();
    areasImpl = (): Promise<Array<{ id: string; boundary: Polygon }>> => pending.promise;

    const refresh = service.refreshNow();
    await flushMicrotasks();

    // The rebuild has started (its area query is pending) — requests still see 'a'.
    expect(service.findCoveringAreaIds(5, 5)).toEqual(['a']);

    pending.resolve([{ id: 'b', boundary: square(0, 0, 10) }]);
    await refresh;
    expect(service.findCoveringAreaIds(5, 5)).toEqual(['b']);
  });

  it('keeps the stale index when a poll-triggered rebuild fails, then recovers on the next poll', async () => {
    jest.useFakeTimers();
    await service.onApplicationBootstrap();
    currentVersion = '2';
    areasImpl = (): Promise<Array<{ id: string; boundary: Polygon }>> =>
      Promise.reject(new Error('transient'));

    await jest.advanceTimersByTimeAsync(POLL_MS);

    expect(service.findCoveringAreaIds(5, 5)).toEqual(['a']); // stale, not dead
    expect(warnSpy).toHaveBeenCalled();

    areasImpl = (): Promise<Array<{ id: string; boundary: Polygon }>> =>
      Promise.resolve([{ id: 'b', boundary: square(0, 0, 10) }]);
    await jest.advanceTimersByTimeAsync(POLL_MS);

    expect(service.findCoveringAreaIds(5, 5)).toEqual(['b']); // self-healed
  });

  it('serializes rebuilds: a refresh enqueued behind an in-flight rebuild reads the newer data', async () => {
    await service.onApplicationBootstrap();
    const first = deferred<Array<{ id: string; boundary: Polygon }>>();
    areasImpl = (): Promise<Array<{ id: string; boundary: Polygon }>> => first.promise;
    const refreshA = service.refreshNow();
    await flushMicrotasks();
    expect(areasQueryCalls()).toBe(2); // bootstrap + in-flight

    // Enqueued while the first is pending: must NOT share its (pre-commit) read.
    areasImpl = (): Promise<Array<{ id: string; boundary: Polygon }>> =>
      Promise.resolve([{ id: 'newer', boundary: square(0, 0, 10) }]);
    const refreshB = service.refreshNow();
    await flushMicrotasks();
    expect(areasQueryCalls()).toBe(2); // still queued, not started

    first.resolve([{ id: 'older', boundary: square(0, 0, 10) }]);
    await refreshA;
    await refreshB;

    expect(areasQueryCalls()).toBe(3);
    expect(service.findCoveringAreaIds(5, 5)).toEqual(['newer']);
  });

  it('clears the poll timer on destroy', async () => {
    jest.useFakeTimers();
    await service.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(1);
    service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
