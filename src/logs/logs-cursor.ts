import { BadRequestException } from '@nestjs/common';

/**
 * Keyset cursor for GET /logs (ADR 0006): position only — filters are re-sent by the
 * client, the cursor never carries them. recordedAt is the timestamptz exactly as
 * Postgres emits it as text ("2026-08-07 17:50:52.845123+00"): it round-trips at full
 * microsecond precision, where a JS Date would silently truncate to milliseconds and
 * could skip or repeat rows at page boundaries.
 *
 * base64url-encoded JSON pair. Opaque as a contract boundary, not a security one —
 * the fields are validated on decode so a hand-crafted value cannot reach SQL.
 */
export interface LogsCursor {
  recordedAt: string;
  id: string;
}

const PG_TIMESTAMPTZ_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:\d{2})?)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeLogsCursor = (cursor: LogsCursor): string =>
  Buffer.from(JSON.stringify([cursor.recordedAt, cursor.id])).toString('base64url');

export const decodeLogsCursor = (raw: string): LogsCursor => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      PG_TIMESTAMPTZ_TEXT.test(parsed[0]) &&
      typeof parsed[1] === 'string' &&
      UUID.test(parsed[1])
    ) {
      return { recordedAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through to the shared 400
  }
  throw new BadRequestException(
    'malformed cursor: pass the nextCursor value from a previous response, unmodified',
  );
};
