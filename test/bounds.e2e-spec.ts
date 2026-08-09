import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, QueryRunner } from 'typeorm';

import { AppModule } from '@app/app.module';
import { LocationsService } from '@app/locations/locations.service';

describe('Connection and query bounds (e2e, ADR 0009)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let locationsService: LocationsService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    locationsService = app.get(LocationsService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('the bounds actually take effect on pooled connections (config path, not just config)', async () => {
    const rows =
      await dataSource.query<Array<{ statement_timeout: string }>>('SHOW statement_timeout');
    expect(rows[0].statement_timeout).toBe('5s');
    const idle = await dataSource.query<Array<{ idle_in_transaction_session_timeout: string }>>(
      'SHOW idle_in_transaction_session_timeout',
    );
    expect(idle[0].idle_in_transaction_session_timeout).toBe('10s');
  });

  it('a held advisory lock hits the statement ceiling, not an unbounded wait (service level since N4B)', async () => {
    // Since ADR 0013 a request only reaches the advisory lock when a membership
    // diff exists — seed a presence row so the report at (0,0) is a departure.
    // Coordinate claim: bounds uses lng 46..48 for this throwaway area.
    // Since N4B (ADR 0015) POST /locations publishes instead of locking, so the
    // lock bound is exercised through the transition service — the code N4C
    // mounts in the worker, where this ceiling is what bounds a stuck partition.
    const areaRows = await dataSource.query<Array<{ id: string }>>(
      `INSERT INTO areas (name, boundary)
       VALUES ('bounds-area', ST_GeomFromText('POLYGON((46 0, 48 0, 48 2, 46 2, 46 0))', 4326))
       RETURNING id`,
    );
    await dataSource.query(
      'INSERT INTO user_area_presence (user_id, area_id, entered_at, last_seen_at) VALUES ($1, $2, now(), now())',
      ['bounds-lock-u', areaRows[0].id],
    );

    const holder: QueryRunner = dataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    await holder.query("SELECT pg_advisory_xact_lock(hashtext('bounds-lock-u'))");
    try {
      const started = Date.now();
      await expect(
        locationsService.report({ userId: 'bounds-lock-u', lng: 0, lat: 0 }),
      ).rejects.toMatchObject({ driverError: { code: '57014' } }); // statement_timeout fired
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThan(4500); // waited the statement ceiling, not a fast failure
    } finally {
      await holder.rollbackTransaction();
      await holder.release();
    }
  }, 20_000);

  it('an exhausted pool turns into a 503 with Retry-After after the acquire timeout', async () => {
    const holders: QueryRunner[] = [];
    // Check out every connection this app instance's pool allows (poolSize 10).
    for (let i = 0; i < 10; i += 1) {
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      holders.push(runner);
    }
    try {
      // Since N4B POST /locations no longer touches the pool — the HTTP 503 shape
      // is exercised through GET /logs, which still reads Postgres per request.
      const started = Date.now();
      const response = await request(app.getHttpServer()).get('/logs?limit=1').expect(503);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeGreaterThan(1500); // waited the acquire bound…
      expect(elapsed).toBeLessThan(4500); // …not the statement bound, and not forever
      expect(response.headers['retry-after']).toBe('5');
      expect(response.body).toMatchObject({
        statusCode: 503,
        message: 'Service temporarily unavailable, retry later',
      });
    } finally {
      for (const runner of holders) {
        await runner.release();
      }
    }
  }, 20_000);

  it('normal traffic is unaffected by the ceilings', async () => {
    await request(app.getHttpServer())
      .post('/locations')
      .send({ userId: 'bounds-normal-u', lng: 0, lat: 0 })
      .expect(202);
    await request(app.getHttpServer()).get('/logs?limit=1').expect(200);
  });
});
