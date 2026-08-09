import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { AppModule } from '@app/app.module';
import { LocationsService } from '@app/locations/locations.service';

/**
 * ACCEPTANCE SCENARIOS AT SERVICE LEVEL SINCE N4B (ADR 0015): POST /locations no
 * longer processes transitions — it publishes (see locations-publish.e2e-spec).
 * The transition semantics below still run against the REAL service, database,
 * cache and advisory lock via LocationsService.report(), which is exactly the
 * code N4C mounts in the worker. N4D re-points these scenarios at the full
 * async path (publish → worker → logs). HTTP-layer tests (validation, the
 * accuracy gate) stay at HTTP, where those contracts still live.
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

interface LogRow {
  user_id: string;
  area_id: string;
  recorded_at: string;
  captured_at: string | null;
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

describe('Locations (e2e) — ACCEPTANCE.md scenarios', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let locationsService: LocationsService;
  // Area A: x 0..10, y 0..10. Area B overlaps A: x 5..15, y 5..15.
  let areaA: string;
  let areaB: string;

  const createArea = async (name: string, boundary: object): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/areas')
      .send({ name, boundary })
      .expect(201);
    return (response.body as Envelope<{ id: string }>).data.id;
  };

  const report = (
    userId: string,
    lng: number,
    lat: number,
    capturedAt?: string,
  ): Promise<ReportResponse> =>
    locationsService.report({
      userId,
      lng,
      lat,
      ...(capturedAt === undefined ? {} : { capturedAt }),
    });

  const logsFor = (userId: string): Promise<LogRow[]> =>
    dataSource.query<LogRow[]>(
      'SELECT user_id, area_id, recorded_at, captured_at FROM logs WHERE user_id = $1 ORDER BY recorded_at, area_id',
      [userId],
    );

  const presenceFor = (userId: string): Promise<Array<{ area_id: string }>> =>
    dataSource.query<Array<{ area_id: string }>>(
      'SELECT area_id FROM user_area_presence WHERE user_id = $1 ORDER BY area_id',
      [userId],
    );

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    locationsService = app.get(LocationsService);
    areaA = await createArea('area-A', square(0, 0, 10));
    areaB = await createArea('area-B', square(5, 5, 10));
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. logs nothing for a user outside all areas', async () => {
    const result = await report('u-outside', 50, 50);
    expect(result.enteredAreaIds).toEqual([]);
    expect(await logsFor('u-outside')).toHaveLength(0);
    expect(await presenceFor('u-outside')).toHaveLength(0);
  });

  it('2. logs exactly one entry when a user crosses into an area', async () => {
    await report('u-cross', 50, 50);
    const result = await report('u-cross', 2, 2);
    expect(result.enteredAreaIds).toEqual([areaA]);
    const logs = await logsFor('u-cross');
    expect(logs).toHaveLength(1);
    expect(logs[0].area_id).toBe(areaA);
    expect(await presenceFor('u-cross')).toEqual([{ area_id: areaA }]);
  });

  it('3. logs nothing further across many pings while inside', async () => {
    await report('u-dwell', 2, 2);
    for (let i = 0; i < 10; i += 1) {
      const result = await report('u-dwell', 2 + i * 0.1, 2);
      expect(result.enteredAreaIds).toEqual([]);
    }
    expect(await logsFor('u-dwell')).toHaveLength(1);
  });

  it('4. logs a second entry after exit and re-entry', async () => {
    await report('u-reenter', 2, 2);
    const exit = await report('u-reenter', 50, 50);
    expect(exit.enteredAreaIds).toEqual([]);
    expect(await presenceFor('u-reenter')).toHaveLength(0);
    const reentry = await report('u-reenter', 3, 3);
    expect(reentry.enteredAreaIds).toEqual([areaA]);
    expect(await logsFor('u-reenter')).toHaveLength(2);
  });

  it('5. logs one entry per area for overlapping areas', async () => {
    const result = await report('u-overlap', 7, 7);
    expect([...result.enteredAreaIds].sort()).toEqual([areaA, areaB].sort());
    const logs = await logsFor('u-overlap');
    expect(logs).toHaveLength(2);
    expect(logs.map((row) => row.area_id).sort()).toEqual([areaA, areaB].sort());
  });

  it('6. logs only the new area when entering a second area while inside the first', async () => {
    await report('u-second', 2, 2);
    const result = await report('u-second', 7, 7);
    expect(result.enteredAreaIds).toEqual([areaB]);
    const logs = await logsFor('u-second');
    expect(logs).toHaveLength(2);
    expect(await presenceFor('u-second')).toHaveLength(2);
  });

  it('7. records an entry on the first-ever report from inside an area', async () => {
    const result = await report('u-firstborn', 2, 2);
    expect(result.enteredAreaIds).toEqual([areaA]);
    expect(await logsFor('u-firstborn')).toHaveLength(1);
  });

  it('8. writes exactly one log for many identical concurrent requests', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => report('u-race', 2, 2)));

    const enteredTotal = results
      .map((result) => result.enteredAreaIds.length)
      .reduce((sum, count) => sum + count, 0);
    expect(enteredTotal).toBe(1);
    expect(await logsFor('u-race')).toHaveLength(1);
    expect(await presenceFor('u-race')).toEqual([{ area_id: areaA }]);
  });

  it('9. persists capturedAt verbatim without letting it affect the outcome', async () => {
    const withClaim = await report('u-observed', 2, 2, '1999-12-31T23:59:59.000Z');
    const control = await report('u-control', 2, 2);
    expect(withClaim.enteredAreaIds).toEqual([areaA]);
    expect(control.enteredAreaIds).toEqual([areaA]);

    const capturedLogs = await logsFor('u-observed');
    expect(capturedLogs).toHaveLength(1);
    expect(new Date(capturedLogs[0].captured_at ?? '').toISOString()).toBe(
      '1999-12-31T23:59:59.000Z',
    );
    const controlLogs = await logsFor('u-control');
    expect(controlLogs).toHaveLength(1);
    expect(controlLogs[0].captured_at).toBeNull();

    // Deprecated alias (ADR 0010): pre-contract clients sending observedAt still persist.
    await locationsService.report({
      userId: 'u-alias',
      lng: 2,
      lat: 2,
      observedAt: '2001-01-01T00:00:00.000Z',
    });
    const aliasLogs = await logsFor('u-alias');
    expect(new Date(aliasLogs[0].captured_at ?? '').toISOString()).toBe('2001-01-01T00:00:00.000Z');
  });

  describe('ADR 0010 payload contract (dedup at service level since N4B)', () => {
    it('stops a replayed seq that would WRITE: duplicate under the lock, nothing stored (ADR 0013 contract)', async () => {
      const first = await locationsService.report({
        userId: 'u-dedup',
        deviceId: 'phone-1',
        seq: 1,
        lng: 2,
        lat: 2,
      });
      expect(first).toMatchObject({ enteredAreaIds: [areaA], duplicate: false });
      await locationsService.report({
        userId: 'u-dedup',
        deviceId: 'phone-1',
        seq: 2,
        lng: 50,
        lat: 50,
      }); // exit processed, last_seq = 2

      // The replay of seq 1 WOULD produce a re-entry — the change path opens, and
      // the dedup check under the lock stops it before anything is written.
      const replay = await locationsService.report({
        userId: 'u-dedup',
        deviceId: 'phone-1',
        seq: 1,
        lng: 2,
        lat: 2,
      });
      expect(replay).toMatchObject({ enteredAreaIds: [], duplicate: true });
      expect(await logsFor('u-dedup')).toHaveLength(1);
      expect(await presenceFor('u-dedup')).toHaveLength(0);
    });

    it('absorbs a NO-CHANGE duplicate on the fast path without the duplicate label (ADR 0013)', async () => {
      await locationsService.report({
        userId: 'u-dedup-noop',
        deviceId: 'phone-1',
        seq: 5,
        lng: 2,
        lat: 2,
      });

      const repeat = await locationsService.report({
        userId: 'u-dedup-noop',
        deviceId: 'phone-1',
        seq: 5,
        lng: 2,
        lat: 2,
      });
      expect(repeat).toMatchObject({ enteredAreaIds: [], duplicate: false });
      expect(await logsFor('u-dedup-noop')).toHaveLength(1);
    });

    it('processes a newer seq normally', async () => {
      await locationsService.report({
        userId: 'u-dedup2',
        deviceId: 'phone-1',
        seq: 1,
        lng: 2,
        lat: 2,
      });
      const newer = await locationsService.report({
        userId: 'u-dedup2',
        deviceId: 'phone-1',
        seq: 2,
        lng: 50,
        lat: 50,
      });
      expect(newer.duplicate).toBe(false);
      expect(await presenceFor('u-dedup2')).toHaveLength(0); // the exit was processed
    });

    it('treats the same seq from a different device independently', async () => {
      await locationsService.report({
        userId: 'u-multi',
        deviceId: 'phone-1',
        seq: 7,
        lng: 50,
        lat: 50,
      });
      const otherDevice = await locationsService.report({
        userId: 'u-multi',
        deviceId: 'watch-2',
        seq: 7,
        lng: 2,
        lat: 2,
      });
      expect(otherDevice).toMatchObject({ enteredAreaIds: [areaA], duplicate: false });
    });

    it('HTTP: rejects unusable GPS accuracy with 422 in the house error shape, before any publish', async () => {
      const response = await request(app.getHttpServer())
        .post('/locations')
        .send({ userId: 'u-acc', lng: 2, lat: 2, accuracy: 150 })
        .expect(422);
      expect(response.body).toMatchObject({ statusCode: 422, path: '/locations' });
      expect(JSON.stringify(response.body)).toContain('accuracy 150m exceeds');
      expect(await logsFor('u-acc')).toHaveLength(0);

      await request(app.getHttpServer())
        .post('/locations')
        .send({ userId: 'u-acc', lng: 2, lat: 2, accuracy: 12.5 })
        .expect(202);
    });

    it('HTTP: rejects deviceId without seq (and vice versa) with 400', async () => {
      await request(app.getHttpServer())
        .post('/locations')
        .send({ userId: 'u-pair', deviceId: 'phone-1', lng: 2, lat: 2 })
        .expect(400);
      await request(app.getHttpServer())
        .post('/locations')
        .send({ userId: 'u-pair', seq: 3, lng: 2, lat: 2 })
        .expect(400);
    });
  });

  it('13. names exactly the areas entered, then an empty array (service result; the HTTP 202 contract lives in locations-publish.e2e-spec)', async () => {
    const first = await report('u-response', 7, 7);
    expect([...first.enteredAreaIds].sort()).toEqual([areaA, areaB].sort());
    const second = await report('u-response', 7, 7);
    expect(second.enteredAreaIds).toEqual([]);
  });

  it('12. HTTP: rejects out-of-range coordinates and oversized userId with 400', async () => {
    await request(app.getHttpServer())
      .post('/locations')
      .send({ userId: 'u', lng: 0, lat: 91 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/locations')
      .send({ userId: 'u', lng: 181, lat: 0 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/locations')
      .send({ userId: 'u', lng: 0, lat: -91 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/locations')
      .send({ userId: 'x'.repeat(65), lng: 0, lat: 0 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/locations')
      .send({ userId: 'u', lng: 0, lat: 0, observedAt: 'not-a-date' })
      .expect(400);
  });

  it('deleting an area cascades its presence and log rows away', async () => {
    const doomed = await createArea('doomed', square(100, 40, 2));
    await report('u-cascade', 101, 41);
    expect(await presenceFor('u-cascade')).toEqual([{ area_id: doomed }]);
    expect(await logsFor('u-cascade')).toHaveLength(1);

    await dataSource.query('DELETE FROM areas WHERE id = $1', [doomed]);

    expect(await presenceFor('u-cascade')).toHaveLength(0);
    expect(await logsFor('u-cascade')).toHaveLength(0);
  });

  it('rolls back the presence row when the log insert fails mid-transaction', async () => {
    // A trigger forces the log insert to fail for one user: if the presence write
    // survives, the code is writing outside the transaction. (The HTTP 500 shape
    // this used to assert moved with the transition path off HTTP — the generic
    // internal-error contract stays pinned by errors.e2e-spec.)
    await dataSource.query(`
      CREATE OR REPLACE FUNCTION fail_txn_proof() RETURNS trigger AS $$
      BEGIN
        IF NEW.user_id = 'u-txn-proof' THEN
          RAISE EXCEPTION 'forced failure for transactionality proof';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_txn_proof BEFORE INSERT ON logs
        FOR EACH ROW EXECUTE FUNCTION fail_txn_proof();
    `);
    try {
      await expect(report('u-txn-proof', 2, 2)).rejects.toThrow('forced failure');
      expect(await presenceFor('u-txn-proof')).toHaveLength(0);
      expect(await logsFor('u-txn-proof')).toHaveLength(0);
    } finally {
      await dataSource.query(
        'DROP TRIGGER trg_fail_txn_proof ON logs; DROP FUNCTION fail_txn_proof();',
      );
    }
  });
});
