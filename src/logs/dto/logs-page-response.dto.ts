import { ApiProperty } from '@nestjs/swagger';

export class LogItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  userId!: string;

  @ApiProperty()
  areaId!: string;

  @ApiProperty({ description: 'Authoritative server receive time (decision 8)' })
  recordedAt!: string;

  @ApiProperty({
    nullable: true,
    description:
      'Device-side reading time (renamed from observedAt by ADR 0010); informational only',
    type: String,
  })
  capturedAt!: string | null;
}

export class LogsPageResponseDto {
  @ApiProperty({
    type: [LogItemDto],
    description: 'Newest first, ordered by (recorded_at, id) descending',
  })
  items!: LogItemDto[];

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Cursor for the next (older) page; null when this page is the last',
  })
  nextCursor!: string | null;
}
