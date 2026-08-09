// Short NON-EMPTY TTL for THIS spec's app instance only — set before the module
// compiles, restored in afterAll (spec files share a worker process). The EMPTY
// TTL stays long deliberately: the spec proves the safe direction does not need
// the short clock. Joi floor is 1 s.
const savedTtl = process.env.PRESENCE_CACHE_TTL_NONEMPTY_S;
process.env.PRESENCE_CACHE_TTL_NONEMPTY_S = '2';

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

  const getMetrics = async (): Promise<Record<string, number>> => {
    const response = await request(app.getHttpServer()).get('/metrics').expect(200);
    return (response.body as Envelope<Record<string, number>>).data;
  };

  /**
   * Puts a user into the dangerous state: cache says "inside A", database says
   * "in nothing". Equivalent to an exit whose post-commit DEL failed.
   */
  const provoke = async (userId: string): Promise<void> => {
    await report(userId, 132, 1); // enter (change path ends with DEL)
    await report(userId, 132, 1); // no-change: populate cache ["<areaId>"]
    expect(JSON.parse((await redis.get(`presence:${userId}`)) ?? 'null')).toEqual([areaId]);
    // Guard the premise: the populate must be on THIS spec's short non-empty clock.
    expect(await redis.ttl(`presence:${userId}`)).toBeLessThanOrEqual(TTL_S);
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
      delete process.env.PRESENCE_CACHE_TTL_NONEMPTY_S;
    } else {
      process.env.PRESENCE_CACHE_TTL_NONEMPTY_S = savedTtl;
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
    // Generous margin: an early flake (2-in-7 on a busy machine, never captured
    // twice) pointed at this window; the explicit key probe below turns any
    // recurrence into a named mechanism instead of a downstream assertion.
    await sleep(TTL_S * 1000 + 1500);
    expect(await redis.get('presence:u-stale-ttl')).toBeNull(); // expired, not lingering
    const recovered = await report('u-stale-ttl', 132, 1);
    expect(recovered.enteredAreaIds).toEqual([areaId]);
    expect(await logCount('u-stale-ttl')).toBe(2);
  });

  it('any differing sample heals the key immediately — recovery does not have to wait for the TTL', async () => {
    await provoke('u-stale-heal');

    const metricsBefore = await getMetrics();

    // Recovery mechanism 2: an event that differs from the stale cache opens the
    // change path, which recomputes against Postgres (writes nothing here) and
    // DELs the key after commit.
    const outside = await report('u-stale-heal', 133.9, 9); // covered by nothing
    expect(outside.enteredAreaIds).toEqual([]);
    expect(await redis.get('presence:u-stale-heal')).toBeNull();

    // The healing event is exactly the trailing fingerprint the upper-bound
    // counter exists for: a hint-opened transaction that wrote nothing.
    const metricsAfter = await getMetrics();
    expect(metricsAfter.presence_change_path_noop_total).toBe(
      metricsBefore.presence_change_path_noop_total + 1,
    );

    // The very next inside event now sees the truth — no TTL wait involved.
    const entry = await report('u-stale-heal', 132, 1);
    expect(entry.enteredAreaIds).toEqual([areaId]);
    expect(await logCount('u-stale-heal')).toBe(2);
  });

  it('a stale "[]" is the SAFE direction: it heals on the next inside ping and can only merge visits', async () => {
    // Real entry, then simulate the post-entry failed DEL: cache retains the
    // pre-entry "[]" while the database says [A].
    await report('u-stale-empty', 132, 1);
    expect(await logCount('u-stale-empty')).toBe(1);
    await redis.set('presence:u-stale-empty', '[]');

    // The suppressed-EXIT direction: outside sample agrees with the stale "[]",
    // fast path returns, the presence row survives — a merged visit, the loss
    // class the system already tolerates by declared non-goal (and which a GPS
    // gap produces anyway).
    await report('u-stale-empty', 133.9, 9);
    const presence = await dataSource.query<Array<{ area_id: string }>>(
      'SELECT area_id FROM user_area_presence WHERE user_id = $1',
      ['u-stale-empty'],
    );
    expect(presence).toHaveLength(1);

    // The healing direction: the next INSIDE ping disagrees with "[]", opens the
    // change path, finds nothing to write (already present — no duplicate log),
    // and DELs the key. No TTL involved; a stale "[]" cannot suppress an entry.
    const inside = await report('u-stale-empty', 132, 1);
    expect(inside.enteredAreaIds).toEqual([]);
    expect(await logCount('u-stale-empty')).toBe(1); // no phantom re-entry
    expect(await redis.get('presence:u-stale-empty')).toBeNull(); // healed
  });
});
