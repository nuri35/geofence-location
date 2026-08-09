import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { USER_ID_MAX_LENGTH } from '../locations.constants';

export class ReportLocationDto {
  @ApiProperty({
    description:
      'Free-form user identifier (auth is a non-goal — this is a claim, not a verified fact)',
    maxLength: USER_ID_MAX_LENGTH,
    example: 'device-7f3a',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(USER_ID_MAX_LENGTH)
  userId!: string;

  @ApiProperty({ description: 'Latitude, WGS84', minimum: -90, maximum: 90, example: 41.01 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ description: 'Longitude, WGS84', minimum: -180, maximum: 180, example: 28.98 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @ApiPropertyOptional({
    description:
      'Device identifier for per-device deduplication (ADR 0010). One user may run several ' +
      'devices with independent seq counters. Must be sent together with seq, or not at all — ' +
      'legacy clients sending neither are processed without deduplication.',
    maxLength: USER_ID_MAX_LENGTH,
    example: 'phone-abc123',
  })
  @ValidateIf((dto: ReportLocationDto) => dto.deviceId !== undefined || dto.seq !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(USER_ID_MAX_LENGTH)
  deviceId?: string;

  @ApiPropertyOptional({
    description:
      'Monotonic per-device sequence number, used for DEDUPLICATION ONLY — it is NOT an ' +
      'ordering guarantee (retries, multi-device users and network reordering all break ' +
      'arrival order). An event whose seq is not newer than the last processed one for this ' +
      '(userId, deviceId) is acknowledged as a duplicate and not reprocessed.',
    example: 42,
  })
  @ValidateIf((dto: ReportLocationDto) => dto.deviceId !== undefined || dto.seq !== undefined)
  @IsInt()
  @Min(0)
  seq?: number;

  @ApiPropertyOptional({
    description:
      'When the device took the reading (ISO 8601). Stored on entry log rows for information ' +
      'only — participates in no logic (ADR 0005). Replaces observedAt (ADR 0010).',
    example: '2026-08-09T12:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  capturedAt?: string;

  @ApiPropertyOptional({
    description:
      'DEPRECATED alias for capturedAt, kept for pre-ADR-0010 clients. Ignored when capturedAt is present.',
    deprecated: true,
  })
  @IsOptional()
  @IsDateString()
  observedAt?: string;

  @ApiPropertyOptional({
    description:
      'GPS error radius in metres. Readings above 100 m are rejected with 422: an error radius ' +
      'that large cannot answer "inside or outside" near any boundary, so processing it would ' +
      'produce a confident answer from unreliable input. Absent = trusted (legacy clients).',
    minimum: 0,
    example: 12.5,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracy?: number;
}
