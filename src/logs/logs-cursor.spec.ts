import { BadRequestException } from '@nestjs/common';

import { decodeLogsCursor, encodeLogsCursor } from './logs-cursor';

describe('logs cursor', () => {
  const cursor = {
    recordedAt: '2026-08-07 17:50:52.845123+00',
    id: '78c2098f-7b44-4e3e-afc5-ac2ce7d016e9',
  };

  it('round-trips a Postgres-text timestamp and uuid exactly', () => {
    expect(decodeLogsCursor(encodeLogsCursor(cursor))).toEqual(cursor);
  });

  it('is opaque on the wire (base64url, no raw timestamp)', () => {
    const encoded = encodeLogsCursor(cursor);
    expect(encoded).not.toContain(':');
    expect(encoded).not.toContain(' ');
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  const malformed = [
    ['garbage', 'not base64 json'],
    [Buffer.from('"just-a-string"').toString('base64url'), 'wrong JSON shape'],
    [Buffer.from('["2026-08-07 17:50:52+00"]').toString('base64url'), 'missing id'],
    [
      Buffer.from('["not-a-timestamp","78c2098f-7b44-4e3e-afc5-ac2ce7d016e9"]').toString(
        'base64url',
      ),
      'invalid timestamp',
    ],
    [Buffer.from('["2026-08-07 17:50:52+00","not-a-uuid"]').toString('base64url'), 'invalid uuid'],
    [encodeLogsCursor(cursor).slice(0, 10), 'truncated'],
    ['', 'empty string'],
  ] as const;

  it.each(malformed)('rejects %s (%s) with a 400, never a 500 or silent restart', (raw) => {
    expect(() => decodeLogsCursor(raw)).toThrow(BadRequestException);
    expect(() => decodeLogsCursor(raw)).toThrow('malformed cursor');
  });
});
