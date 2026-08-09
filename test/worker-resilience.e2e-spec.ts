import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
 * N4D-short (the three tests N5 stands on):
 *  1. a SIGKILL landing provably MID-TRANSACTION loses nothing and duplicates
 *     nothing — ack-after-commit made real, and the rehearsal for rebalance
 *     handover;
 *  2. per-user ordering through the partition (enter → exit → re-enter with a
 *     second user interleaved);
 *  3. recorded_at under a large, obvious backlog equals the message's
 *     receivedAt — never worker-processing time.
 *
 * Coordinate plane claim: lng 177..179 (see testing-verification skill).
 * Test 1 spawns REAL worker processes from dist/ — the chain builds before e2e;
 * a stale or missing dist fails loudly below rather than testing old code.
 *
 * KNOWN INSTABILITY (recorded 2026-08-09, deliberately not chased further —
 * N4D-short scope): solo, this spec passed 3× consecutively; under the full
 * serial suite it intermittently fails (~1 in 3–4 runs) on TEST-RIG TIMING,
 * not on the product properties. Believed causes, in likelihood order:
 *  1. test 1's kill choreography races the ADR 0009 statement ceiling — the
 *     worker's advisory-lock wait is bounded at 5 s, so if suite load delays
 *     the detect-then-SIGKILL sequence past it, the wait times out (57014),
 *     the message nacks/redelivers, and the choreography loses its window;
 *  2. management-API consumer counts lag several seconds under load, starving
 *     the waitFor(consumers)/guard steps (partially mitigated: explicit 30 s
 *     hook timeouts — jest's DEFAULT 5 s hook limit caused one whole class of
 *     these failures on slow teardowns).
 * If a later phase needs this stable in CI, the fix direction is a test-only
 * relaxation of the statement ceiling for the spawned worker (env override)
 * plus AMQP-level consumer checks instead of management stats.
 */

interface Envelope<T> {
  statusCode: number;
  timestamp: string;
  data: T;
}

const REPO_ROOT = join(__dirname, '..');
const WORKER_DIST = join(REPO_ROOT, 'dist', 'worker-main.js');

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

const partitionConsumerCount = async (): Promise<number> => {
  const response = await fetch(`${MGMT}/queues/%2F`, { headers: { authorization: MGMT_AUTH } });
  const queues = (await response.json()) as Array<{ name: string; consumers?: number }>;
  return queues
    .filter((queue) => queue.name.startsWith('loc.events.p'))
    .reduce((sum, queue) => sum + (queue.consumers ?? 0), 0);
};

/** Peeks (requeues) messages on every partition; returns payloads. */
const peekAllPayloads = async (): Promise<Array<Record<string, unknown>>> => {
  const payloads: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 8; i += 1) {
    const response = await fetch(`${MGMT}/queues/%2F/loc.events.p${i}/get`, {
      method: 'POST',
      headers: { authorization: MGMT_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ count: 50, ackmode: 'reject_requeue_true', encoding: 'auto' }),
    });
    const messages = (await response.json()) as Array<{ payload: string }>;
    for (const message of messages) {
      payloads.push(JSON.parse(message.payload) as Record<string, unknown>);
    }
  }
  return payloads;
};

describe('Worker resilience (e2e, N4D-short)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  const createArea = async (name: string, lngBase: number): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/areas')
      .send({ name, boundary: square(lngBase, 0, 1) })
      .expect(201);
    return (response.body as Envelope<{ id: string }>).data.id;
  };

  const postLocation = (userId: string, lng: number, lat: number): Promise<unknown> =>
    request(app.getHttpServer()).post('/locations').send({ userId, lng, lat }).expect(202);

  const logRows = (userId: string): Promise<Array<{ area_id: string; recorded_at: string }>> =>
    dataSource.query<Array<{ area_id: string; recorded_at: string }>>(
      'SELECT area_id, recorded_at FROM logs WHERE user_id = $1 ORDER BY recorded_at',
      [userId],
    );

  const presenceFor = (userId: string): Promise<Array<{ area_id: string }>> =>
    dataSource.query<Array<{ area_id: string }>>(
      'SELECT area_id FROM user_area_presence WHERE user_id = $1',
      [userId],
    );

  const spawnWorker = (): ChildProcess =>
    spawn(process.execPath, [WORKER_DIST], {
      cwd: REPO_ROOT,
      env: { ...process.env }, // inherits POSTGRES_DB=geofence_test from setup-env
      stdio: 'ignore',
    });

  beforeAll(async () => {
    if (!existsSync(WORKER_DIST)) {
      throw new Error(
        'dist/worker-main.js missing — run `npm run build` first: this spec kills REAL ' +
          'worker processes, and testing a stale dist would prove nothing',
      );
    }
    if ((await partitionConsumerCount()) > 0) {
      throw new Error('a consumer is already attached to the partitions — stop it first');
    }
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

  it('1. a SIGKILL provably MID-TRANSACTION: the message returns and is processed exactly once', async () => {
    const areaId = await createArea('resilience-kill-area', 177);
    let worker: ChildProcess | null = null;
    // A RAW pg client, deliberately outside the app's pool: the ADR 0009 session
    // bounds (idle-in-transaction kill 10 s) would murder a pooled holder before
    // this test finishes — which is the bounds working, but not what we're testing.
    const lockHolder = new Client({
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
    });
    try {
      // Freeze the processing window deterministically: hold u-kill's advisory
      // lock so the worker blocks INSIDE its change-path transaction.
      await lockHolder.connect();
      await lockHolder.query('BEGIN');
      await lockHolder.query("SELECT pg_advisory_xact_lock(hashtext('u-kill'))");

      worker = spawnWorker();
      await waitFor(
        'worker 1 to attach consumers',
        async () => (await partitionConsumerCount()) === 8,
        20_000,
      );

      await postLocation('u-kill', 177.5, 0.5);

      // The proof the kill lands mid-flight: a backend is WAITING on the advisory
      // lock inside lock_user_and_read_presence — the worker is inside the
      // transaction, before commit, holding the delivery unacked.
      await waitFor('the worker to block on the held advisory lock', async () => {
        const rows = await dataSource.query<Array<{ n: string }>>(
          `SELECT count(*) AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
             AND query LIKE '%lock_user_and_read_presence%'`,
        );
        return Number(rows[0].n) === 1;
      });
      expect(await logRows('u-kill')).toHaveLength(0); // nothing committed yet

      worker.kill('SIGKILL'); // mid-transaction, delivery unacked
      worker = null;
      await waitFor(
        'the dead worker’s consumers to disappear',
        async () => (await partitionConsumerCount()) === 0,
      );

      // The broker got the message back; Postgres rolled the transaction back.
      await waitFor('the message to be requeued', async () =>
        (await peekAllPayloads()).some((payload) => payload.userId === 'u-kill'),
      );
      expect(await logRows('u-kill')).toHaveLength(0); // not lost forward, not committed
      await lockHolder.query('ROLLBACK');

      worker = spawnWorker();
      await waitFor(
        'the redelivered message to produce its log row',
        async () => (await logRows('u-kill')).length === 1,
        25_000,
      );
      await sleep(1_500); // let any phantom duplicate land before asserting exactly-once
      const rows = await logRows('u-kill');
      expect(rows).toHaveLength(1); // exactly once: not zero, not two
      expect(rows[0].area_id).toBe(areaId);
    } finally {
      worker?.kill('SIGKILL');
      await lockHolder.end().catch(() => undefined);
      await waitFor(
        'consumers gone after test 1',
        async () => (await partitionConsumerCount()) === 0,
      );
    }
  }, 90_000);

  it('2. per-user ordering: enter → exit → re-enter yields exactly two entries in order, interleaved with another user', async () => {
    const areaId = await createArea('resilience-order-area', 178.2);
    await purgePartitions();

    // The full sequence is published BEFORE any worker exists — pure backlog, so
    // processing order is queue order, interleaved across two users. 5 ms gaps
    // keep receivedAt stamps strictly distinct.
    await postLocation('u-order', 178.5, 0.5); // enter
    await sleep(5);
    await postLocation('u-bystander', 178.5, 0.5); // other user enters
    await sleep(5);
    await postLocation('u-order', 178.9, 5); // exit (lat 5: covered by nothing in this claim)
    await sleep(5);
    await postLocation('u-bystander', 178.9, 5); // other user exits
    await sleep(5);
    await postLocation('u-order', 178.5, 0.5); // re-enter

    const workerContext: INestApplicationContext = await NestFactory.createApplicationContext(
      WorkerModule,
      { logger: ['warn', 'error'] },
    );
    try {
      await waitFor(
        'both users’ sequences to finish',
        async () => {
          const order = await logRows('u-order');
          const bystander = await logRows('u-bystander');
          return order.length === 2 && bystander.length === 1;
        },
        25_000,
      );

      const rows = await logRows('u-order');
      expect(rows).toHaveLength(2); // exit processed between them, exactly two entries
      expect(rows.map((row) => row.area_id)).toEqual([areaId, areaId]);
      expect(new Date(rows[0].recorded_at).getTime()).toBeLessThan(
        new Date(rows[1].recorded_at).getTime(),
      ); // first entry strictly before the re-entry
      expect(await presenceFor('u-order')).toEqual([{ area_id: areaId }]); // ended inside
      expect(await presenceFor('u-bystander')).toEqual([]); // ended outside — their exit processed too
    } finally {
      await workerContext.close();
      await waitFor(
        'consumers gone after test 2',
        async () => (await partitionConsumerCount()) === 0,
      );
    }
  }, 60_000);

  it('3. recorded_at under a large backlog equals the message’s receivedAt, to the millisecond', async () => {
    const areaId = await createArea('resilience-backlog-area', 179.0);
    await purgePartitions();

    await postLocation('u-backlog', 179.4, 0.5);

    // Read the exact receivedAt the API stamped, straight off the queued message.
    const queued = (await peekAllPayloads()).find((payload) => payload.userId === 'u-backlog');
    expect(queued).toBeDefined();
    const receivedAt = queued?.receivedAt as string;

    // The large, obvious gap: a wrong implementation (recorded_at = now()) would
    // be at least this far off — impossible to pass by coincidence.
    const BACKLOG_MS = 6_000;
    await sleep(BACKLOG_MS);

    const processingStarted = Date.now();
    const workerContext: INestApplicationContext = await NestFactory.createApplicationContext(
      WorkerModule,
      { logger: ['warn', 'error'] },
    );
    try {
      await waitFor(
        'the backlogged entry to be logged',
        async () => (await logRows('u-backlog')).length === 1,
        25_000,
      );
      const rows = await logRows('u-backlog');
      expect(rows[0].area_id).toBe(areaId);
      // Exact equality with the API's stamp, not a window.
      expect(new Date(rows[0].recorded_at).toISOString()).toBe(new Date(receivedAt).toISOString());
      // And the stamp is provably from BEFORE the backlog, not processing time.
      expect(processingStarted - new Date(rows[0].recorded_at).getTime()).toBeGreaterThanOrEqual(
        BACKLOG_MS,
      );
    } finally {
      await workerContext.close();
      await waitFor(
        'consumers gone after test 3',
        async () => (await partitionConsumerCount()) === 0,
      );
    }
  }, 60_000);
});
