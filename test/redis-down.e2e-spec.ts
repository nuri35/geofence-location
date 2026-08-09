// Point THIS spec's app instance at a port where nothing listens: every cache
// operation errors and must fall through to Postgres. Set before module compile,
// and RESTORED in afterAll — spec files share a worker process, so an unreverted
// mutation would poison the next file's app boot.
const savedRedisEnv = { host: process.env.REDIS_HOST, port: process.env.REDIS_PORT };
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '6390';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { AppModule } from '@app/app.module';

/**
 * Acceptance scenario 10, un-retired (ADR 0013): with Redis unreachable the system
 * keeps every transition semantic — correctness never depends on any store but
 * PostgreSQL. Coordinate plane claim: lng 135..145 (see testing-verification skill).
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

describe('Redis down (e2e) — scenario 10: transition semantics survive losing the cache', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let areaA: string;
  let areaB: string;

  const report = async (userId: string, lng: number, lat: number): Promise<ReportResponse> => {
    const response = await request(app.getHttpServer())
      .post('/locations')
      .send({ userId, lng, lat })
      .expect(201);
    return (response.body as Envelope<ReportResponse>).data;
  };

  const logsFor = (userId: string): Promise<Array<{ area_id: string }>> =>
    dataSource.query<Array<{ area_id: string }>>(
      'SELECT area_id FROM logs WHERE user_id = $1 ORDER BY recorded_at, area_id',
      [userId],
    );

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init(); // the boot itself is part of the scenario: no Redis, app up
    dataSource = app.get(DataSource);

    const create = async (name: string, lngBase: number): Promise<string> => {
      const response = await request(app.getHttpServer())
        .post('/areas')
        .send({ name, boundary: square(lngBase, 0, 4) })
        .expect(201);
      return (response.body as Envelope<{ id: string }>).data.id;
    };
    areaA = await create('rd-area-A', 135);
    areaB = await create('rd-area-B', 137); // overlaps A on 137..139
  });

  afterAll(async () => {
    await app.close();
    process.env.REDIS_HOST = savedRedisEnv.host;
    process.env.REDIS_PORT = savedRedisEnv.port;
  });

  it('logs exactly one entry on crossing in, none while dwelling', async () => {
    await report('u-rd-dwell', 144, 9); // outside
    const entry = await report('u-rd-dwell', 136, 1);
    expect(entry.enteredAreaIds).toEqual([areaA]);
    for (let i = 0; i < 5; i += 1) {
      const ping = await report('u-rd-dwell', 136, 1 + i * 0.1);
      expect(ping.enteredAreaIds).toEqual([]);
    }
    expect(await logsFor('u-rd-dwell')).toHaveLength(1);
  });

  it('logs a second entry after exit and re-entry', async () => {
    await report('u-rd-reenter', 136, 1);
    const exit = await report('u-rd-reenter', 144, 9);
    expect(exit.enteredAreaIds).toEqual([]);
    const reentry = await report('u-rd-reenter', 136, 1);
    expect(reentry.enteredAreaIds).toEqual([areaA]);
    expect(await logsFor('u-rd-reenter')).toHaveLength(2);
  });

  it('logs one entry per area for overlapping areas in a single request', async () => {
    const result = await report('u-rd-overlap', 137.5, 1);
    expect([...result.enteredAreaIds].sort()).toEqual([areaA, areaB].sort());
    expect(await logsFor('u-rd-overlap')).toHaveLength(2);
  });

  it('20 identical concurrent requests still write exactly one log', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(app.getHttpServer())
          .post('/locations')
          .send({ userId: 'u-rd-race', lng: 136, lat: 1 }),
      ),
    );
    for (const response of results) {
      expect(response.status).toBe(201);
    }
    const entered = results
      .map((r) => (r.body as Envelope<ReportResponse>).data.enteredAreaIds.length)
      .reduce((sum, n) => sum + n, 0);
    expect(entered).toBe(1);
    expect(await logsFor('u-rd-race')).toHaveLength(1);
  });
});
