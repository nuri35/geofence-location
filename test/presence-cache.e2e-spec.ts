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
 * Presence-cache behaviour (ADR 0013). Coordinate plane claim: lng 120..130
 * (see testing-verification skill).
 *
 * The "cache actually served it" proofs work by DESYNC: force cache and database
 * apart, send a request whose outcome differs depending on which store answered,
 * and read the outcome. No spies, no instrumentation — behaviour only.
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

describe('Presence cache (e2e)', () => {
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
      .send({ name: 'cache-area', boundary: square(120, 0, 4) })
      .expect(201);
    areaId = (response.body as Envelope<{ id: string }>).data.id;
  });

  afterAll(async () => {
    redis.disconnect();
    await app.close();
  });

  it('a miss loads presence from Postgres and populates the key with a TTL', async () => {
    await report('u-cache-miss', 122, 2); // enter: change path ends with DEL
    await report('u-cache-miss', 122, 2); // no-change: miss → unlocked read → populate

    const raw = await redis.get('presence:u-cache-miss');
    expect(JSON.parse(raw ?? 'null')).toEqual([areaId]);
    const ttl = await redis.ttl('presence:u-cache-miss');
    expect(ttl).toBeGreaterThan(0); // bounded staleness, never a permanent key
  });

  it('a hit answers without touching Postgres — proven by desync, not by spying', async () => {
    await report('u-cache-hit', 122, 2);
    await report('u-cache-hit', 122, 2); // populates ["<areaId>"]

    // Desync: the DATABASE now says "outside", the cache still says "inside".
    await dataSource.query('DELETE FROM user_area_presence WHERE user_id = $1', ['u-cache-hit']);

    // If this request consulted Postgres it would see a diff and log a re-entry;
    // served from the cache, it sees "no change" and does nothing.
    const result = await report('u-cache-hit', 122, 2);
    expect(result.enteredAreaIds).toEqual([]);
    expect(await logCount('u-cache-hit')).toBe(1);
  });

  it('a user in no areas caches as "[]" and the second request does not touch Postgres', async () => {
    await report('u-cache-empty', 129, 9); // covered by nothing: miss → read [] → populate "[]"
    expect(await redis.get('presence:u-cache-empty')).toBe('[]');

    // Desync in the OTHER direction: the database now claims membership.
    await dataSource.query(
      'INSERT INTO user_area_presence (user_id, area_id, entered_at, last_seen_at) VALUES ($1, $2, now(), now())',
      ['u-cache-empty', areaId],
    );

    // If this read Postgres it would see a departure diff and open a transaction
    // that deletes the row; served from the cached "[]", nothing happens.
    await report('u-cache-empty', 129, 9);
    const rows = await dataSource.query<Array<{ area_id: string }>>(
      'SELECT area_id FROM user_area_presence WHERE user_id = $1',
      ['u-cache-empty'],
    );
    expect(rows).toHaveLength(1); // still there → Postgres was not consulted

    await dataSource.query('DELETE FROM user_area_presence WHERE user_id = $1', ['u-cache-empty']);
  });

  it('a transition invalidates the key (DEL after commit, not update)', async () => {
    await report('u-cache-inval', 122, 2);
    await report('u-cache-inval', 122, 2); // populate
    expect(await redis.get('presence:u-cache-inval')).not.toBeNull();

    await report('u-cache-inval', 129, 9); // exit: change path → DEL after commit
    expect(await redis.get('presence:u-cache-inval')).toBeNull();
  });
});
