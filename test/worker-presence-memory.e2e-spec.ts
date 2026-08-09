import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { NestFactory } from '@nestjs/core';
import { config } from 'dotenv';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { AppModule } from '@app/app.module';
import { PresenceMemoryService } from '@app/presence/presence-memory.service';
import { PresenceMetricsService } from '@app/presence/presence-metrics.service';
import { WorkerModule } from '@app/worker/worker.module';

config();

/**
 * N5B (ADR 0018): worker-local presence memory.
 *  1. a memory-warm no-change ping consults neither Redis nor Postgres — proven
 *     by DESYNC (a planted wrong Redis value stays untouched and unconsulted),
 *     not by spying;
 *  2. a committed transition updates memory immediately and DELs the Redis key;
 *  3. with Redis unreachable, warm users are unaffected and cold users fall
 *     through to Postgres correctly.
 *
 * Coordinate plane claim: lng 36..38 (see testing-verification skill).
 *
 * KNOWN SUITE-ORDER SENSITIVITY (recorded 2026-08-09, not chased per the
 * two-attempt flake limit): solo this spec is stable (repeatedly green); in one
 * full-suite run it failed while running directly AFTER worker-resilience,
 * whose kill choreography spawns and SIGKILLs real worker processes — the
 * believed cause is a lingering consumer/connection from a killed child eating
 * this spec's messages before its own worker attaches. If it recurs, the fix
 * direction is a consumer-drain guard in beforeAll like locations-publish's.
 */

interface Envelope<T> {
  statusCode: number;
  timestamp: string;
  data: T;
}

const square = (lngBase: number, latBase: number, size: number): object => ({
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

const waitFor = async (
  label: string,
  condition: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MGMT = `http://127.0.0.1:${process.env.RABBITMQ_MGMT_PORT ?? '15672'}/api`;
const MGMT_AUTH =
  'Basic ' +
  Buffer.from(
    `${process.env.RABBITMQ_USER ?? 'geofence'}:${process.env.RABBITMQ_PASSWORD ?? 'geofence'}`,
  ).toString('base64');

const purgePartitions = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await fetch(`${MGMT}/queues/%2F/loc.events.p${i}/contents`, {
      method: 'DELETE',
      headers: { authorization: MGMT_AUTH },
    });
  }
};

describe('Worker-local presence memory (e2e, N5B)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let redis: Redis;

  // Sizes are passed explicitly and kept DISJOINT: an earlier version used
  // 1°-wide areas whose overlap made an entry produce TWO logs, and a
  // waitFor(=== 1) sailed straight past 2 — the order-dependent failure this
  // spec briefly had.
  const createArea = async (name: string, lngBase: number, size: number): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/areas')
      .send({ name, boundary: square(lngBase, 0, size) })
      .expect(201);
    return (response.body as Envelope<{ id: string }>).data.id;
  };

  const postLocation = (userId: string, lng: number, lat: number): Promise<unknown> =>
    request(app.getHttpServer()).post('/locations').send({ userId, lng, lat }).expect(202);

  const logCount = async (userId: string): Promise<number> => {
    const rows = await dataSource.query<Array<{ n: string }>>(
      'SELECT count(*) AS n FROM logs WHERE user_id = $1',
      [userId],
    );
    return Number(rows[0].n);
  };

  beforeAll(async () => {
    await purgePartitions();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    });
  }, 30_000);

  afterAll(async () => {
    redis.disconnect();
    await app.close();
    await purgePartitions();
  }, 30_000);

  it('a memory-warm no-change ping consults neither Redis nor Postgres — the desync stays invisible', async () => {
    const areaId = await createArea('mem-warm-area', 36, 0.6);
    const workerContext = await NestFactory.createApplicationContext(WorkerModule, {
      logger: ['warn', 'error'],
    });
    try {
      const memory = workerContext.get(PresenceMemoryService);
      const metrics = workerContext.get(PresenceMetricsService);

      await postLocation('u-mem-warm', 36.3, 0.3); // enter: memory := [area]
      await waitFor('the entry to be processed', async () => (await logCount('u-mem-warm')) === 1);
      expect(memory.get('u-mem-warm')).toEqual([areaId]);

      // DESYNC: plant a wrong value in Redis. If any read touched Redis, the
      // hint would say "outside", open the change path, find nothing to write,
      // and DEL the key — all observable below.
      await redis.set('presence:u-mem-warm', '[]');
      const noopsBefore = metrics.snapshot().presence_change_path_noop_total;

      await postLocation('u-mem-warm', 36.2, 0.2); // no-change ping, memory-warm
      await sleep(1_000); // no counter to wait on — the assertion is that nothing happens

      expect(await logCount('u-mem-warm')).toBe(1); // no re-entry
      expect(await redis.get('presence:u-mem-warm')).toBe('[]'); // untouched: not read, not DELed
      expect(metrics.snapshot().presence_change_path_noop_total).toBe(noopsBefore); // no wasted txn
      await redis.del('presence:u-mem-warm');
    } finally {
      await workerContext.close();
    }
  }, 60_000);

  it('a committed transition updates memory immediately and the Redis key is gone', async () => {
    const areaId = await createArea('mem-commit-area', 36.7, 0.6);
    // Pre-plant a key so the post-commit DEL has something observable to remove.
    await redis.set('presence:u-mem-commit', '["stale-anything"]');

    const workerContext = await NestFactory.createApplicationContext(WorkerModule, {
      logger: ['warn', 'error'],
    });
    try {
      const memory = workerContext.get(PresenceMemoryService);
      await postLocation('u-mem-commit', 37.0, 0.3);
      await waitFor(
        'the entry to be processed',
        async () => (await logCount('u-mem-commit')) === 1,
      );

      expect(memory.get('u-mem-commit')).toEqual([areaId]); // memory holds the new value NOW
      expect(await redis.get('presence:u-mem-commit')).toBeNull(); // DELed, not updated
    } finally {
      await workerContext.close();
    }
  }, 60_000);

  it('with Redis unreachable: warm users unaffected, cold users fall through to Postgres', async () => {
    const areaId = await createArea('mem-nored-area', 37.4, 0.6);
    // A worker whose Redis points nowhere — every cache op errors, reads never
    // needed it (memory/Postgres), the post-commit DEL fails and is counted.
    const savedPort = process.env.REDIS_PORT;
    process.env.REDIS_PORT = '6390';
    let workerContext: INestApplicationContext | null = null;
    try {
      workerContext = await NestFactory.createApplicationContext(WorkerModule, {
        logger: ['warn', 'error'],
      });
      const memory = workerContext.get(PresenceMemoryService);
      const metrics = workerContext.get(PresenceMetricsService);

      // Warm path: enter (change path commits despite the failing DEL), then ping.
      await postLocation('u-mem-nored', 37.7, 0.3);
      await waitFor(
        'the entry to commit with Redis down',
        async () => (await logCount('u-mem-nored')) === 1,
      );
      expect(memory.get('u-mem-nored')).toEqual([areaId]);
      expect(metrics.snapshot().presence_invalidate_failed_gets_failing_total).toBeGreaterThan(0);

      await postLocation('u-mem-nored', 37.65, 0.25); // memory-warm no-op, no Redis involved
      await sleep(800);
      expect(await logCount('u-mem-nored')).toBe(1);

      // Cold path: a user this worker has never seen, outside everything —
      // memory miss -> Postgres read -> correct no-op, Redis never consulted.
      await postLocation('u-mem-cold', 36.2, 5);
      await waitFor('the cold user to be seeded from Postgres', () =>
        Promise.resolve(memory.get('u-mem-cold') !== undefined),
      );
      expect(memory.get('u-mem-cold')).toEqual([]);
      expect(await logCount('u-mem-cold')).toBe(0);
    } finally {
      process.env.REDIS_PORT = savedPort;
      await workerContext?.close();
    }
  }, 60_000);
});
