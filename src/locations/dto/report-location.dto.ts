import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
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
      'Client-reported observation time (ISO 8601). Stored on entry log rows for information ' +
      'only — it participates in no logic: no comparison, no rejection, no ordering (ADR 0005).',
    example: '2026-08-07T12:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  observedAt?: string;
}
