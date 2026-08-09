import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LOGS_TABLE } from './entities/log.entity';
import { ListLogsQueryDto, LogItemDto, LogsPageResponseDto } from './dto';
import { decodeLogsCursor, encodeLogsCursor } from './logs-cursor';

interface LogRow {
  id: string;
  user_id: string;
  area_id: string;
  recorded_at: Date;
  /** recorded_at as Postgres text — full microsecond precision for the cursor. */
  cursor_ts: string;
  captured_at: Date | null;
}

@Injectable()
export class LogsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Keyset pagination over (recorded_at, id), newest first (ADR 0006). The row-value
   * comparison in the cursor predicate is what makes pages stable under concurrent
   * inserts: new rows land ahead of an in-flight walk's position and are never
   * skipped into or repeated. Fetches limit+1 to decide nextCursor without a count.
   */
  async list(query: ListLogsQueryDto): Promise<LogsPageResponseDto> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const bind = (value: unknown): number => params.push(value);

    if (query.userId !== undefined) {
      conditions.push(`"user_id" = $${bind(query.userId)}`);
    }
    if (query.areaId !== undefined) {
      conditions.push(`"area_id" = $${bind(query.areaId)}::uuid`);
    }
    if (query.from !== undefined) {
      conditions.push(`"recorded_at" >= $${bind(query.from)}::timestamptz`);
    }
    if (query.to !== undefined) {
      conditions.push(`"recorded_at" <= $${bind(query.to)}::timestamptz`);
    }
    if (query.cursor !== undefined) {
      const cursor = decodeLogsCursor(query.cursor); // 400 on malformed input
      conditions.push(
        `("recorded_at", "id") < ($${bind(cursor.recordedAt)}::timestamptz, $${bind(cursor.id)}::uuid)`,
      );
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.dataSource.query<LogRow[]>(
      `SELECT "id", "user_id", "area_id", "recorded_at", "recorded_at"::text AS "cursor_ts", "captured_at"
       FROM "${LOGS_TABLE}"
       ${where}
       ORDER BY "recorded_at" DESC, "id" DESC
       LIMIT $${bind(query.limit + 1)}`,
      params,
    );

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const lastRow = page[page.length - 1];

    return {
      items: page.map((row): LogItemDto => ({
        id: row.id,
        userId: row.user_id,
        areaId: row.area_id,
        recordedAt: row.recorded_at.toISOString(),
        capturedAt: row.captured_at === null ? null : row.captured_at.toISOString(),
      })),
      nextCursor: hasMore
        ? encodeLogsCursor({ recordedAt: lastRow.cursor_ts, id: lastRow.id })
        : null,
    };
  }
}
