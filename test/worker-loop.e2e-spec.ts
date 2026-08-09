// Short poll so the worker's snapshot picks up areas created mid-test quickly.
// Set before module compile, restored in afterAll (spec files share a worker process).
const savedPollInterval = process.env.AREAS_POLL_INTERVAL_MS;
process.env.AREAS_POLL_INTERVAL_MS = '500';

import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { NestFactory } from '@nestjs/core';
import { config } from 'dotenv';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { AppModule } from '@app/app.module';
import { AreaSnapshotService } from '@app/areas/area-snapshot.service';
import { WorkerConsumerService } from '@app/worker/worker-consumer.service';
import { WorkerModule } from '@app/worker/worker.module';

config();

/**
 * N4C's reason to exist: the loop that has never run before — POST /locations →
 * 202 → partition queue → worker consumes → log row appears. Coordinate plane
 * claim: lng 174..176 (see testing-verification skill).
 *
 * WAITING STRATEGY (N4D will lean on this): poll-with-timeout, never fixed
 * sleeps — `waitFor(condition, timeoutMs)` polls every 100 ms and throws with
 * the caller's label on timeout, so a hang names the stage that hung.
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
  timeoutMs = 10_000,
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

const deadLetterEventIds = async (): Promise<string[]> => {
  const response = await fetch(`${MGMT}/queues/%2F/loc.dead/get`, {
    method: 'POST',
    headers: { authorization: MGMT_AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ count: 50, ackmode: 'reject_requeue_true', encoding: 'auto' }),
  });
  const messages = (await response.json()) as Array<{ properties: { message_id?: string } }>;
  return messages.map((message) => message.properties.message_id ?? '');
};

describe('Worker loop (e2e, N4C — ADR 0016)', () => {
  let app: INestApplication<App>;
  let workerContext: INestApplicationContext;
  let dataSource: DataSource;
  let workerConsumer: WorkerConsumerService;
  let workerSnapshot: AreaSnapshotService;

  const createArea = async (name: string, lngBase: number): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/areas')
      .send({ name, boundary: square(lngBase, 0, 1) })
      .expect(201);
    return (response.body as Envelope<{ id: string }>).data.id;
  };

  const postLocation = async (userId: string, lng: number, lat: number): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/locations')
      .send({ userId, lng, lat })
      .expect(202);
    return (response.body as Envelope<{ eventId: string }>).data.eventId;
  };

  const logRows = (userId: string): Promise<Array<{ area_id: string; recorded_at: string }>> =>
    dataSource.query<Array<{ area_id: string; recorded_at: string }>>(
      'SELECT area_id, recorded_at FROM logs WHERE user_id = $1',
      [userId],
    );

  beforeAll(async () => {
    await purgePartitions();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);

    // The worker as it really boots (its own context, connection, consumers) —
    // in-process so the test can read its counters and snapshot directly.
    workerContext = await NestFactory.createApplicationContext(WorkerModule, {
      logger: ['warn', 'error'],
    });
    workerConsumer = workerContext.get(WorkerConsumerService);
    workerSnapshot = workerContext.get(AreaSnapshotService);
  }, 30_000);

  afterAll(async () => {
    await workerContext.close();
    await app.close();
    await purgePartitions();
    if (savedPollInterval === undefined) {
      delete process.env.AREAS_POLL_INTERVAL_MS;
    } else {
      process.env.AREAS_POLL_INTERVAL_MS = savedPollInterval;
    }
    // 30s: closing a worker context + app + purging queues legitimately exceeds
    // jest's default 5s HOOK timeout under load — observed as a teardown-only flake.
  }, 30_000);

  it('closes the loop: POST 202 → partition → worker → log row, timestamped with receivedAt', async () => {
    const areaId = await createArea('worker-loop-area', 174);
    await waitFor('worker snapshot to include the new area', () =>
      Promise.resolve(workerSnapshot.findCoveringAreaIds(174.5, 0.5).includes(areaId)),
    );

    const before = Date.now();
    await postLocation('u-worker-loop', 174.5, 0.5);
    const after = Date.now();

    await waitFor(
      'the entry log row to appear',
      async () => (await logRows('u-worker-loop')).length === 1,
    );
    const rows = await logRows('u-worker-loop');
    expect(rows[0].area_id).toBe(areaId);
    // recorded_at must be the API's receivedAt stamp — inside the POST window,
    // regardless of when the worker got to it (decision 8 under backlog).
    const recordedAt = new Date(rows[0].recorded_at).getTime();
    expect(recordedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(recordedAt).toBeLessThanOrEqual(after + 1000);
  }, 30_000);

  it('acks a stale-area FK violation without dead-lettering (the one narrow exception)', async () => {
    const doomedId = await createArea('worker-doomed-area', 175.5);
    await waitFor('worker snapshot to include the doomed area', () =>
      Promise.resolve(workerSnapshot.findCoveringAreaIds(175.9, 0.5).includes(doomedId)),
    );

    // Delete WITHOUT a version bump: both snapshots keep the area — the exact
    // stale window ADR 0012 recorded as the accepted hazard.
    await dataSource.query('DELETE FROM areas WHERE id = $1', [doomedId]);

    const dropsBefore = workerConsumer.staleAreaDropCount;
    const eventId = await postLocation('u-worker-stale', 175.9, 0.5);

    await waitFor('the stale-area drop counter to increment', () =>
      Promise.resolve(workerConsumer.staleAreaDropCount === dropsBefore + 1),
    );
    expect(await logRows('u-worker-stale')).toHaveLength(0); // nothing written
    expect(await deadLetterEventIds()).not.toContain(eventId); // acked, NOT dead-lettered
  }, 30_000);
});
