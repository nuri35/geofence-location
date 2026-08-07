import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { AppModule } from '@app/app.module';
import { REDIS_CLIENT } from '@app/redis/redis.constants';

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

describe('Presence cache path (e2e, PRESENCE_READ_STRATEGY=cache)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let redis: Redis;
  let areaId: string;

  const report = async (userId: string, lng: number, lat: number): Promise<string[]> => {
    const response = await request(app.getHttpServer())
      .post('/locations')
      .send({ userId, lng, lat })
      .expect(201);
    return (response.body as Envelope<{ enteredAreaIds: string[] }>).data.enteredAreaIds;
  };

  const logCount = async (userId: string): Promise<number> => {
    const rows = await dataSource.query<Array<{ count: string }>>(
      'SELECT count(*) AS count FROM logs WHERE user_id = $1',
      [userId],
    );
    return parseInt(rows[0].count, 10);
  };

  beforeAll(async () => {
    process.env.PRESENCE_READ_STRATEGY = 'cache';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    redis = app.get<Redis>(REDIS_CLIENT);

    const created = await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'cache-area', boundary: square(60, 20, 10) })
      .expect(201);
    areaId = (created.body as Envelope<{ id: string }>).data.id;
  });

  afterAll(async () => {
    delete process.env.PRESENCE_READ_STRATEGY;
    await app.close();
  });

  it('caches membership as a JSON array string after a miss', async () => {
    await report('c-basic', 65, 25);
    // Transition invalidates; a no-change request re-populates.
    await report('c-basic', 65, 25);
    await expect(redis.get('presence:c-basic')).resolves.toBe(JSON.stringify([areaId]));
  });

  it('a cache hit skips the database read — observable via a stale cache', async () => {
    await report('c-hit', 65, 25);
    await report('c-hit', 65, 25); // repopulates cache after the invalidation
    expect(await logCount('c-hit')).toBe(1);

    // Remove the presence row DIRECTLY, bypassing invalidation. If the next request
    // read the database it would see no membership and log a re-entry; if it uses the
    // cache it sees the stale membership and logs nothing.
    await dataSource.query("DELETE FROM user_area_presence WHERE user_id = 'c-hit'");
    const entered = await report('c-hit', 65, 25);

    expect(entered).toEqual([]);
    expect(await logCount('c-hit')).toBe(1);
  });

  it('caches "[]" for a user in no areas, and the second request does not touch the database', async () => {
    await report('c-empty', 0, -50);
    await expect(redis.get('presence:c-empty')).resolves.toBe('[]');

    // Plant a presence row DIRECTLY. A database read would see it as departed and
    // delete it; a negative-cache hit ("[]") never learns it exists.
    await dataSource.query('INSERT INTO user_area_presence (user_id, area_id) VALUES ($1, $2)', [
      'c-empty',
      areaId,
    ]);
    await report('c-empty', 0, -50);

    const survivors = await dataSource.query<Array<{ area_id: string }>>(
      "SELECT area_id FROM user_area_presence WHERE user_id = 'c-empty'",
    );
    expect(survivors).toHaveLength(1);
    await dataSource.query("DELETE FROM user_area_presence WHERE user_id = 'c-empty'");
  });

  it('invalidates the cache after a transition', async () => {
    await report('c-inval', 65, 25); // enter: state changed → invalidated
    await expect(redis.get('presence:c-inval')).resolves.toBeNull();

    await report('c-inval', 65, 25); // no change → miss → repopulated
    await expect(redis.get('presence:c-inval')).resolves.toBe(JSON.stringify([areaId]));

    await report('c-inval', 0, -50); // exit: state changed → invalidated again
    await expect(redis.get('presence:c-inval')).resolves.toBeNull();
  });

  it('transition semantics hold end-to-end under the cache strategy', async () => {
    expect(await report('c-flow', 65, 25)).toEqual([areaId]); // enter
    expect(await report('c-flow', 66, 26)).toEqual([]); // dwell
    expect(await report('c-flow', 0, -50)).toEqual([]); // exit
    expect(await report('c-flow', 65, 25)).toEqual([areaId]); // re-enter
    expect(await logCount('c-flow')).toBe(2);
  });
});
