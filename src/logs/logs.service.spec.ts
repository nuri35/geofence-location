import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { DEFAULT_LOGS_PAGE_SIZE } from './logs.constants';
import { encodeLogsCursor } from './logs-cursor';
import { LogsService } from './logs.service';

const row = (n: number): Record<string, unknown> => ({
  id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  user_id: `u-${n}`,
  area_id: '11111111-1111-1111-1111-111111111111',
  recorded_at: new Date(1754580000000 + n),
  cursor_ts: `2026-08-07 17:00:00.00${n}+00`,
  observed_at: null,
});

describe('LogsService', () => {
  let service: LogsService;
  const query = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    query.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [LogsService, { provide: getDataSourceToken(), useValue: { query } }],
    }).compile();

    service = module.get(LogsService);
  });

  const lastCall = (): [string, unknown[]] => query.mock.calls[0] as [string, unknown[]];

  it('applies no WHERE clause and the default limit+1 when unfiltered', async () => {
    await service.list({ limit: DEFAULT_LOGS_PAGE_SIZE });

    const [sql, params] = lastCall();
    expect(sql).not.toContain('WHERE');
    expect(sql).toContain('ORDER BY "recorded_at" DESC, "id" DESC');
    expect(params).toEqual([DEFAULT_LOGS_PAGE_SIZE + 1]);
  });

  it('combines all filters and the cursor predicate with AND, parameterized', async () => {
    const cursor = encodeLogsCursor({
      recordedAt: '2026-08-07 17:00:00.001+00',
      id: '00000000-0000-0000-0000-000000000001',
    });
    await service.list({
      limit: 10,
      userId: 'u-1',
      areaId: '11111111-1111-1111-1111-111111111111',
      from: '2026-08-01T00:00:00Z',
      to: '2026-08-08T00:00:00Z',
      cursor,
    });

    const [sql, params] = lastCall();
    expect(sql).toContain('"user_id" = $1');
    expect(sql).toContain('"area_id" = $2::uuid');
    expect(sql).toContain('"recorded_at" >= $3::timestamptz');
    expect(sql).toContain('"recorded_at" <= $4::timestamptz');
    expect(sql).toContain('("recorded_at", "id") < ($5::timestamptz, $6::uuid)');
    expect(params).toHaveLength(7);
    expect(params[6]).toBe(11);
  });

  it('returns nextCursor built from the last row when limit+1 rows come back', async () => {
    query.mockResolvedValue([row(3), row(2), row(1)]);

    const result = await service.list({ limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe(
      encodeLogsCursor({ recordedAt: row(2).cursor_ts as string, id: row(2).id as string }),
    );
  });

  it('returns nextCursor null when the result fits the page exactly', async () => {
    query.mockResolvedValue([row(2), row(1)]);

    const result = await service.list({ limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it('returns an empty page with null cursor for no rows', async () => {
    const result = await service.list({ limit: 2 });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor before any SQL runs', async () => {
    await expect(service.list({ limit: 2, cursor: 'garbage' })).rejects.toThrow(
      BadRequestException,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
