// TTL small for THIS spec's app instance only — set before the module compiles,
// restored in afterAll (spec files share a worker process). Joi floor is 1 s.
const savedTtl = process.env.PRESENCE_CACHE_TTL_S;
process.env.PRESENCE_CACHE_TTL_S = '2';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { config } from 'dotenv';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { AppModule } from '@app/app.module';

config();

/**
 * THE PROVOCATION (ADR 0013): force cache and database out of sync in the
 * dangerous direction — a stale key saying "unchanged" while the database says
 * otherwise — then send an event that must produce an entry, and record what
 * actually happens: lost, delayed, or recovered, and by which mechanism.
 *
 * Coordinate plane claim: lng 131..134 (see testing-verification skill).
 */

interface Envelope<T> {
  statusCode: number;
  timestamp: string;
  data: T;
}

interface ReportResponse {
  enteredAreaIds: string[];
  duplicate: boolean;
}

const TTL_S = 2;

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('Stale-presence provocation (e2e) — the ADR 0007 hole, measured', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let redis: Redis;
  let areaId: string;

  const report = async (userId: string, lng: number, lat: number): Promise<ReportResponse> => {
    const response = await request(app.getHttpServer())
      .post('/locations')
      .send({ userId, lng, lat })
      .expect(201);
    return (response.body as Envelope<ReportResponse>).data;
  };

  const logCount = async (userId: string): Promise<number> => {
    const rows = await dataSource.query<Array<{ n: string }>>(
      'SELECT count(*) AS n FROM logs WHERE user_id = $1',
      [userId],
    );
    return Number(rows[0].n);
  };

  /**
   * Puts a user into the dangerous state: cache says "inside A", database says
   * "in nothing". Equivalent to an exit whose post-commit DEL failed.
   */
  const provoke = async (userId: string): Promise<void> => {
    await report(userId, 132, 1); // enter (change path ends with DEL)
    await report(userId, 132, 1); // no-change: populate cache ["<areaId>"]
    expect(JSON.parse((await redis.get(`presence:${userId}`)) ?? 'null')).toEqual([areaId]);
    await dataSource.query('DELETE FROM user_area_presence WHERE user_id = $1', [userId]);
  };

  beforeAll(async () => {
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

    const response = await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'stale-area', boundary: square(131, 0, 2) })
      .expect(201);
    areaId = (response.body as Envelope<{ id: string }>).data.id;
  });

  afterAll(async () => {
    redis.disconnect();
    await app.close();
    if (savedTtl === undefined) {
      delete process.env.PRESENCE_CACHE_TTL_S;
    } else {
      process.env.PRESENCE_CACHE_TTL_S = savedTtl;
    }
  });

  it('the entry IS lost while the key is stale, and IS recovered by TTL expiry — delay bounded by the TTL', async () => {
    await provoke('u-stale-ttl');
    expect(await logCount('u-stale-ttl')).toBe(1);

    // The database says this must produce an entry. The stale cache says "unchanged".
    const suppressed = await report('u-stale-ttl', 132, 1);
    expect(suppressed.enteredAreaIds).toEqual([]); // ← the lost entry, demonstrated
    expect(await logCount('u-stale-ttl')).toBe(1);

    // Recovery mechanism 1: the TTL. After expiry the key is gone, the read falls
    // through to Postgres, the diff appears, the change path writes the entry.
    await sleep(TTL_S * 1000 + 500);
    const recovered = await report('u-stale-ttl', 132, 1);
    expect(recovered.enteredAreaIds).toEqual([areaId]);
    expect(await logCount('u-stale-ttl')).toBe(2);
  });

  it('any differing sample heals the key immediately — recovery does not have to wait for the TTL', async () => {
    await provoke('u-stale-heal');

    // Recovery mechanism 2: an event that differs from the stale cache opens the
    // change path, which recomputes against Postgres (writes nothing here) and
    // DELs the key after commit.
    const outside = await report('u-stale-heal', 133.9, 9); // covered by nothing
    expect(outside.enteredAreaIds).toEqual([]);
    expect(await redis.get('presence:u-stale-heal')).toBeNull();

    // The very next inside event now sees the truth — no TTL wait involved.
    const entry = await report('u-stale-heal', 132, 1);
    expect(entry.enteredAreaIds).toEqual([areaId]);
    expect(await logCount('u-stale-heal')).toBe(2);
  });
});
