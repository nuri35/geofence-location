import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { AppModule } from '@app/app.module';

interface Envelope<T> {
  statusCode: number;
  timestamp: string;
  data: T;
}

interface LogItem {
  id: string;
  userId: string;
  areaId: string;
  recordedAt: string;
  capturedAt: string | null;
}

interface LogsPage {
  items: LogItem[];
  nextCursor: string | null;
}

describe('Logs (e2e) — keyset pagination invariants', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let areaA: string;
  let areaB: string;

  const getPage = async (queryString: string): Promise<LogsPage> => {
    const response = await request(app.getHttpServer()).get(`/logs${queryString}`).expect(200);
    return (response.body as Envelope<LogsPage>).data;
  };

  const walkAll = async (baseQuery: string, limit: number): Promise<LogItem[]> => {
    const collected: LogItem[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard += 1) {
      const separator = baseQuery.includes('?') ? '&' : '?';
      const page: LogsPage = await getPage(
        cursor === null
          ? `${baseQuery}${separator}limit=${limit}`
          : `${baseQuery}${separator}limit=${limit}&cursor=${encodeURIComponent(cursor)}`,
      );
      collected.push(...page.items);
      if (page.nextCursor === null) {
        return collected;
      }
      cursor = page.nextCursor;
    }
    throw new Error('pagination did not terminate');
  };

  const insertLog = (
    userId: string,
    areaId: string,
    recordedAt: string,
    capturedAt: string | null = null,
  ): Promise<unknown> =>
    dataSource.query(
      'INSERT INTO logs (user_id, area_id, recorded_at, captured_at) VALUES ($1, $2, $3::timestamptz, $4)',
      [userId, areaId, recordedAt, capturedAt],
    );

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);

    const createArea = async (name: string, lngBase: number): Promise<string> => {
      const response = await request(app.getHttpServer())
        .post('/areas')
        .send({
          name,
          boundary: {
            type: 'Polygon',
            coordinates: [
              [
                [lngBase, 40],
                [lngBase + 1, 40],
                [lngBase + 1, 41],
                [lngBase, 41],
                [lngBase, 40],
              ],
            ],
          },
        })
        .expect(201);
      return (response.body as Envelope<{ id: string }>).data.id;
    };
    // e2e specs share one database AND one coordinate plane: locations.e2e-spec owns
    // lng 0..15 and 100..102, areas.e2e-spec owns lng 0..30 around lat 0..41. Stay clear.
    areaA = await createArea('logs-area-A', 150);
    areaB = await createArea('logs-area-B', 160);

    // 7 controlled rows for lg-1/lg-2 across both areas, spread over one hour, plus
    // two rows sharing an identical timestamp so the id tiebreak is actually exercised.
    await insertLog('lg-1', areaA, '2026-08-07 10:00:00.000001+00');
    await insertLog('lg-1', areaB, '2026-08-07 10:10:00.000001+00');
    await insertLog('lg-2', areaA, '2026-08-07 10:20:00.000001+00', '2026-08-07 10:19:00+00');
    await insertLog('lg-1', areaA, '2026-08-07 10:30:00.000001+00');
    await insertLog('lg-2', areaB, '2026-08-07 10:40:00.000001+00');
    await insertLog('lg-1', areaA, '2026-08-07 10:50:00.000001+00');
    await insertLog('lg-2', areaA, '2026-08-07 10:50:00.000001+00'); // identical timestamp
  });

  afterAll(async () => {
    await dataSource.query("DELETE FROM logs WHERE user_id LIKE 'lg-%' OR user_id LIKE 'mid-%'");
    await app.close();
  });

  const lgOnly = (items: LogItem[]): LogItem[] =>
    items.filter((item) => item.userId.startsWith('lg-'));

  it('walking every page yields each row exactly once, newest first', async () => {
    const all = lgOnly(await walkAll('?', 2));

    expect(all).toHaveLength(7);
    const ids = new Set(all.map((item) => item.id));
    expect(ids.size).toBe(7);
    const times = all.map((item) => new Date(item.recordedAt).getTime());
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    }
  });

  it('rows inserted mid-pagination neither skip nor repeat existing rows', async () => {
    const firstPage = await getPage('?limit=3');
    expect(firstPage.nextCursor).not.toBeNull();

    // A newer row lands after page 1 was read — ahead of the cursor position.
    await insertLog('mid-flight', areaA, '2026-08-07 11:59:59.000001+00');

    const rest: LogItem[] = [];
    let cursor = firstPage.nextCursor;
    while (cursor !== null) {
      const page: LogsPage = await getPage(`?limit=3&cursor=${encodeURIComponent(cursor)}`);
      rest.push(...page.items);
      cursor = page.nextCursor;
    }

    const combined = [...firstPage.items, ...rest];
    const ids = combined.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length); // no repeats
    expect(lgOnly(combined)).toHaveLength(7); // no skips among pre-existing rows
    expect(combined.some((item) => item.userId === 'mid-flight')).toBe(false); // newer than the walk
  });

  it('filters work alone and combined', async () => {
    const byUser = lgOnly(await walkAll('?userId=lg-1', 10));
    expect(byUser).toHaveLength(4);
    expect(byUser.every((item) => item.userId === 'lg-1')).toBe(true);

    const byArea = lgOnly(await walkAll(`?areaId=${areaB}`, 10));
    expect(byArea).toHaveLength(2);
    expect(byArea.every((item) => item.areaId === areaB)).toBe(true);

    const byRange = lgOnly(await walkAll('?from=2026-08-07T10:15:00Z&to=2026-08-07T10:45:00Z', 10));
    expect(byRange).toHaveLength(3);

    const combined = lgOnly(await walkAll(`?userId=lg-2&areaId=${areaA}`, 10));
    expect(combined).toHaveLength(2);
    expect(combined.every((item) => item.userId === 'lg-2' && item.areaId === areaA)).toBe(true);
  });

  it('returns an empty page with null cursor when nothing matches', async () => {
    const page = await getPage('?userId=nobody-ever');
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('a result exactly one page long ends with null cursor', async () => {
    const page = await getPage('?userId=lg-1&limit=4');
    expect(page.items).toHaveLength(4);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor with 400 and a clear message', async () => {
    const response = await request(app.getHttpServer())
      .get('/logs?cursor=not-a-cursor')
      .expect(400);
    const body = response.body as { message: string | string[] };
    expect(JSON.stringify(body.message)).toContain('malformed cursor');
  });

  it('rejects a page size above the maximum with 400', async () => {
    await request(app.getHttpServer()).get('/logs?limit=501').expect(400);
    await request(app.getHttpServer()).get('/logs?limit=0').expect(400);
  });

  it('capturedAt is returned verbatim where present, null elsewhere', async () => {
    const withClaim = await getPage('?userId=lg-2&limit=10');
    const claimed = withClaim.items.find((item) => item.capturedAt !== null);
    expect(claimed?.capturedAt).toBe('2026-08-07T10:19:00.000Z');
  });
});
