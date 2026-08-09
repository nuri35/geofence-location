import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { NestFactory } from '@nestjs/core';
import { config } from 'dotenv';
import { Client } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { AppModule } from '@app/app.module';
import { WorkerModule } from '@app/worker/worker.module';

config();

/**
 * N5A (ADR 0017): per-user parallelism inside a partition.
 *  - head-of-line proof: a user held mid-transaction (advisory lock) must NOT
 *    delay other users queued BEHIND them in the SAME partition;
 *  - ordering proof: the enter → exit → re-enter sequence still yields exactly
 *    two entries, now under prefetch 16 with a live worker.
 *
 * Coordinate plane claim: lng 32..34 (see testing-verification skill).
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

/** partition queue name -> userIds of the messages currently sitting in it. */
const peekPlacements = async (): Promise<Map<string, string[]>> => {
  const placements = new Map<string, string[]>();
  for (let i = 0; i < 8; i += 1) {
    const response = await fetch(`${MGMT}/queues/%2F/loc.events.p${i}/get`, {
      method: 'POST',
      headers: { authorization: MGMT_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ count: 50, ackmode: 'reject_requeue_true', encoding: 'auto' }),
    });
    const messages = (await response.json()) as Array<{ payload: string }>;
    placements.set(
      `loc.events.p${i}`,
      messages.map((message) => (JSON.parse(message.payload) as { userId: string }).userId),
    );
  }
  return placements;
};

describe('Worker per-user parallelism (e2e, N5A)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

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
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await purgePartitions();
  }, 30_000);

  it('a slow user does NOT block other users queued behind them in the SAME partition', async () => {
    const areaId = await createArea('par-hol-area', 32, 1);

    // Discovery: find four users that hash to ONE partition, so the fast users
    // are genuinely queued BEHIND the slow one — the head-of-line shape.
    const candidates = Array.from({ length: 24 }, (_, i) => `par-hol-${i}`);
    for (const candidate of candidates) {
      await postLocation(candidate, 32.5, 0.5);
    }
    const placements = await peekPlacements();
    const cohort = [...placements.values()].find((users) => users.length >= 4)?.slice(0, 4);
    await purgePartitions();
    expect(cohort).toBeDefined(); // 24 users over 8 partitions: some queue holds ≥4
    const [slowUser, ...fastUsers] = cohort as string[];
    // Reset any state the discovery pass created for the cohort.
    await dataSource.query('DELETE FROM logs WHERE user_id = ANY($1)', [cohort]);
    await dataSource.query('DELETE FROM user_area_presence WHERE user_id = ANY($1)', [cohort]);

    // Freeze the slow user mid-transaction, exactly like the N4D kill test.
    const lockHolder = new Client({
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
    });
    let workerContext: INestApplicationContext | null = null;
    try {
      await lockHolder.connect();
      await lockHolder.query('BEGIN');
      await lockHolder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [slowUser]);

      // Backlog IN ORDER on one partition: slow first, fast ones behind it.
      await postLocation(slowUser, 32.5, 0.5);
      for (const fastUser of fastUsers) {
        await postLocation(fastUser, 32.5, 0.5);
      }

      workerContext = await NestFactory.createApplicationContext(WorkerModule, {
        logger: ['warn', 'error'],
      });

      // With prefetch 1 this would deadlock-by-design: the slow head blocks the
      // partition. With per-user chains the fast users complete WHILE the slow
      // user is still provably held mid-transaction.
      const fastStarted = Date.now();
      await waitFor('all fast users to be logged while the slow one is held', async () => {
        for (const fastUser of fastUsers) {
          if ((await logCount(fastUser)) !== 1) {
            return false;
          }
        }
        return true;
      });
      const fastDoneMs = Date.now() - fastStarted;

      // The slow user is still mid-flight: lock waiter present, nothing logged.
      const waiters = await dataSource.query<Array<{ n: string }>>(
        `SELECT count(*) AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
           AND query LIKE '%lock_user_and_read_presence%'`,
      );
      expect(Number(waiters[0].n)).toBe(1);
      expect(await logCount(slowUser)).toBe(0);

      await lockHolder.query('ROLLBACK');
      await waitFor(
        'the slow user to complete after release',
        async () => (await logCount(slowUser)) === 1,
      );

      // Observable concurrency: fast users finished in fastDoneMs while the slow
      // head-of-line message was still blocked — under prefetch 1 they could not
      // have finished until the lock released.
      console.log(
        `[N5A] ${fastUsers.length} fast users completed in ${fastDoneMs}ms while ${slowUser} was held mid-transaction`,
      );
      expect(fastDoneMs).toBeLessThan(10_000);
      for (const fastUser of fastUsers) {
        const rows = await dataSource.query<Array<{ area_id: string }>>(
          'SELECT area_id FROM logs WHERE user_id = $1',
          [fastUser],
        );
        expect(rows).toEqual([{ area_id: areaId }]);
      }
    } finally {
      await lockHolder.end().catch(() => undefined);
      await workerContext?.close();
    }
  }, 60_000);

  it('same user still processes strictly in order under raised prefetch: enter → exit → re-enter = exactly two entries', async () => {
    const areaId = await createArea('par-order-area', 33.5, 0.5);
    const workerContext = await NestFactory.createApplicationContext(WorkerModule, {
      logger: ['warn', 'error'],
    });
    try {
      // LIVE worker, rapid-fire sequence, another user interleaved.
      await postLocation('par-order-u', 33.7, 0.2); // enter
      await postLocation('par-order-other', 33.7, 0.2);
      await sleep(3);
      await postLocation('par-order-u', 32.9, 5); // exit (covered by nothing)
      await postLocation('par-order-other', 32.9, 5);
      await sleep(3);
      await postLocation('par-order-u', 33.7, 0.2); // re-enter

      await waitFor(
        'the sequence to finish',
        async () => (await logCount('par-order-u')) === 2,
        20_000,
      );
      await sleep(500); // let a hypothetical out-of-order third entry land

      const rows = await dataSource.query<Array<{ area_id: string; recorded_at: string }>>(
        'SELECT area_id, recorded_at FROM logs WHERE user_id = $1 ORDER BY recorded_at',
        ['par-order-u'],
      );
      expect(rows).toHaveLength(2); // the exit processed between the two entries
      expect(rows.map((row) => row.area_id)).toEqual([areaId, areaId]);
      expect(new Date(rows[0].recorded_at).getTime()).toBeLessThan(
        new Date(rows[1].recorded_at).getTime(),
      );
      const presence = await dataSource.query<Array<{ area_id: string }>>(
        'SELECT area_id FROM user_area_presence WHERE user_id = $1',
        ['par-order-u'],
      );
      expect(presence).toEqual([{ area_id: areaId }]); // ended inside, once
    } finally {
      await workerContext.close();
    }
  }, 60_000);
});
