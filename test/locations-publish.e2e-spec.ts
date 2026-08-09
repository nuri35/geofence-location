import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { config } from 'dotenv';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '@app/app.module';

config();

/**
 * The N4B ingestion contract (ADR 0015): POST /locations validates, stamps,
 * publishes, returns 202 { eventId }. Queue placement is asserted against the
 * REAL broker via the management API. The broker is shared with dev, so the
 * spec purges the partition queues it inspects (nothing consumes them yet) and
 * peeks with requeue so it never destroys what it only wants to see.
 */

interface Envelope<T> {
  statusCode: number;
  timestamp: string;
  data: T;
}

interface QueuedMessage {
  routing_key: string;
  properties: { message_id?: string; type?: string; delivery_mode?: number };
  payload: string;
}

const MGMT = `http://127.0.0.1:${process.env.RABBITMQ_MGMT_PORT ?? '15672'}/api`;
const MGMT_AUTH =
  'Basic ' +
  Buffer.from(
    `${process.env.RABBITMQ_USER ?? 'geofence'}:${process.env.RABBITMQ_PASSWORD ?? 'geofence'}`,
  ).toString('base64');
const PARTITIONS = 8; // dev topology (MQ_PARTITION_COUNT in .env.example)

const mgmt = async (method: string, path: string, body?: object): Promise<unknown> => {
  const response = await fetch(`${MGMT}${path}`, {
    method,
    headers: {
      authorization: MGMT_AUTH,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`${method} ${path} -> ${response.status}`);
  }
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : null;
};

const purgePartitions = async (): Promise<void> => {
  for (let i = 0; i < PARTITIONS; i += 1) {
    await mgmt('DELETE', `/queues/%2F/loc.events.p${i}/contents`);
  }
};

/** Peek (requeue) up to 50 messages per partition; returns partition -> messages. */
const peekAll = async (): Promise<Map<string, QueuedMessage[]>> => {
  const result = new Map<string, QueuedMessage[]>();
  for (let i = 0; i < PARTITIONS; i += 1) {
    const name = `loc.events.p${i}`;
    const messages = (await mgmt('POST', `/queues/%2F/${name}/get`, {
      count: 50,
      ackmode: 'reject_requeue_true',
      encoding: 'auto',
    })) as QueuedMessage[];
    result.set(name, messages ?? []);
  }
  return result;
};

const findByEventId = (
  peeked: Map<string, QueuedMessage[]>,
  eventId: string,
): { partition: string; message: QueuedMessage } | null => {
  for (const [partition, messages] of peeked) {
    for (const message of messages) {
      if (message.properties.message_id === eventId) {
        return { partition, message };
      }
    }
  }
  return null;
};

describe('Locations publishing (e2e, N4B — ADR 0015)', () => {
  let app: INestApplication<App>;

  const post = (body: object): request.Test =>
    request(app.getHttpServer()).post('/locations').send(body);

  beforeAll(async () => {
    // This spec asserts messages REMAIN in the partitions. Any attached consumer
    // (a worker process, a lingering worker-loop context, an IDE-launched run)
    // would eat them and turn every assertion into a mystery. A consumer from the
    // PREVIOUS spec can linger a few seconds in the management stats after its
    // close — wait it out, and only then fail with a named cause.
    const consumerTotal = async (): Promise<number> => {
      let total = 0;
      for (let i = 0; i < PARTITIONS; i += 1) {
        const queue = (await mgmt('GET', `/queues/%2F/loc.events.p${i}`)) as {
          consumers?: number;
        };
        total += queue.consumers ?? 0;
      }
      return total;
    };
    const deadline = Date.now() + 10_000;
    let lingering = await consumerTotal();
    while (lingering > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      lingering = await consumerTotal();
    }
    if (lingering > 0) {
      throw new Error(
        `${lingering} consumer(s) still attached to the partitions after 10s — a worker is ` +
          'running; stop it before this spec (it asserts message presence)',
      );
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await purgePartitions();
    // 30s: the consumer-drain wait above can legitimately use 10s, which is past
    // jest's DEFAULT 5s hook timeout — the exact way this hook failed once.
  }, 30_000);

  afterAll(async () => {
    await purgePartitions();
    await app.close();
  }, 30_000);

  it('a valid request returns 202 with an eventId and no transition fields', async () => {
    const response = await post({ userId: 'n4b-u1', lng: 41, lat: 41 }).expect(202);
    const body = response.body as Envelope<{ eventId: string }>;
    expect(body.statusCode).toBe(202);
    expect(body.data.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.data).not.toHaveProperty('enteredAreaIds');
    expect(body.data).not.toHaveProperty('duplicate');
  });

  it('the message lands in a partition, persistent, carrying the full v1 schema', async () => {
    await purgePartitions();
    const response = await post({
      userId: 'n4b-u2',
      deviceId: 'phone-9',
      seq: 3,
      lng: 41.5,
      lat: 40.5,
      accuracy: 12.5,
      capturedAt: '2026-08-09T10:00:00.000Z',
    }).expect(202);
    const { eventId } = (response.body as Envelope<{ eventId: string }>).data;

    const found = findByEventId(await peekAll(), eventId);
    expect(found).not.toBeNull();
    expect(found?.message.routing_key).toBe('n4b-u2'); // raw userId — the exchange hashes
    expect(found?.message.properties.type).toBe('location.v1');
    expect(found?.message.properties.delivery_mode).toBe(2); // persistent
    const payload = JSON.parse(found?.message.payload ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({
      v: 1,
      eventId,
      userId: 'n4b-u2',
      deviceId: 'phone-9',
      seq: 3,
      lng: 41.5,
      lat: 40.5,
      accuracy: 12.5,
      capturedAt: '2026-08-09T10:00:00.000Z',
    });
    expect(typeof payload.receivedAt).toBe('string');
    expect(new Date(payload.receivedAt as string).toISOString()).toBe(payload.receivedAt);
  });

  it('the same userId lands in the same partition across requests', async () => {
    await purgePartitions();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await post({ userId: 'n4b-sticky', lng: 41 + i, lat: 40 }).expect(202);
      ids.push((response.body as Envelope<{ eventId: string }>).data.eventId);
    }
    const peeked = await peekAll();
    const partitions = ids.map((id) => findByEventId(peeked, id)?.partition);
    expect(partitions[0]).toBeDefined();
    expect(new Set(partitions).size).toBe(1); // one user, one lane — per-user ordering holds
  });

  it('validation and the accuracy gate reject BEFORE any publish', async () => {
    await purgePartitions();
    await post({ userId: 'n4b-rejects', lng: 181, lat: 0 }).expect(400);
    await post({ userId: 'n4b-rejects', lng: 41, lat: 40, accuracy: 150 }).expect(422);
    await post({ userId: 'n4b-rejects', deviceId: 'd', lng: 41, lat: 40 }).expect(400);

    const peeked = await peekAll();
    const total = [...peeked.values()].reduce((sum, messages) => sum + messages.length, 0);
    expect(total).toBe(0); // nothing reached the broker
  });
});
