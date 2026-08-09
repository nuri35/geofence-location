// Poll interval for THIS spec's app instance only (each e2e spec file boots its own
// process and its own AppModule) — must be set before the module compiles, same
// pattern as setup-env.ts. Joi floor is 250 ms.
process.env.AREAS_POLL_INTERVAL_MS = '500';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { AppModule } from '@app/app.module';

/**
 * Snapshot lifecycle behaviour (ADR 0012). Coordinate plane claim: lng 105..115
 * (see testing-verification skill).
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

const POLL_MS = 500;

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

describe('Area snapshot lifecycle (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  const report = async (userId: string, lng: number, lat: number): Promise<ReportResponse> => {
    const response = await request(app.getHttpServer())
      .post('/locations')
      .send({ userId, lng, lat })
      .expect(201);
    return (response.body as Envelope<ReportResponse>).data;
  };

  /** Simulates ANOTHER instance creating an area: raw SQL + version bump, no local refresh. */
  const createAreaOutOfBand = async (name: string, boundary: object): Promise<string> => {
    const rows = await dataSource.query<Array<{ id: string }>>(
      'INSERT INTO areas (name, boundary) VALUES ($1, ST_GeomFromGeoJSON($2)) RETURNING id',
      [name, JSON.stringify(boundary)],
    );
    await dataSource.query('UPDATE area_version SET version = version + 1');
    return rows[0].id;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  it('an area created out-of-band is invisible until the poll picks it up, then takes effect', async () => {
    const areaId = await createAreaOutOfBand('snap-poll-area', square(105, 0, 2));

    // Inside the new area, but this instance's snapshot predates it: no entry.
    const before = await report('u-snap-poll', 106, 1);
    expect(before.enteredAreaIds).toEqual([]);

    await sleep(POLL_MS * 3);

    const after = await report('u-snap-poll', 106, 1);
    expect(after.enteredAreaIds).toEqual([areaId]);
  });

  it('an area created through POST /areas takes effect with no wait (local synchronous refresh)', async () => {
    const response = await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'snap-local-area', boundary: square(109, 0, 2) })
      .expect(201);
    const areaId = (response.body as Envelope<{ id: string }>).data.id;

    const result = await report('u-snap-local', 110, 1);
    expect(result.enteredAreaIds).toEqual([areaId]);
  });

  it('requests racing a version bump all succeed and end consistent', async () => {
    // 30 concurrent reports inside a long-standing area while a bump lands mid-flight:
    // whichever snapshot each request sees, it must be a complete one.
    const stableResponse = await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'snap-race-stable', boundary: square(112, 4, 2) })
      .expect(201);
    const stableId = (stableResponse.body as Envelope<{ id: string }>).data.id;

    const bump = createAreaOutOfBand('snap-race-newcomer', square(113, 0, 2));
    const reports = Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        request(app.getHttpServer())
          .post('/locations')
          .send({ userId: `u-snap-race-${i}`, lng: 113, lat: 5 }),
      ),
    );
    const [, responses] = await Promise.all([bump, reports]);

    for (const response of responses) {
      expect(response.status).toBe(201);
      expect((response.body as Envelope<ReportResponse>).data.enteredAreaIds).toEqual([stableId]);
    }
    const presence = await dataSource.query<Array<{ user_id: string }>>(
      "SELECT user_id FROM user_area_presence WHERE area_id = $1 AND user_id LIKE 'u-snap-race-%'",
      [stableId],
    );
    expect(presence).toHaveLength(30);
  });
});
