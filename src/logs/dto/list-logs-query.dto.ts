import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { USER_ID_MAX_LENGTH } from '@app/locations/locations.constants';

import { DEFAULT_LOGS_PAGE_SIZE, MAX_LOGS_PAGE_SIZE } from '../logs.constants';

export class ListLogsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by user id', maxLength: USER_ID_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(USER_ID_MAX_LENGTH)
  userId?: string;

  @ApiPropertyOptional({ description: 'Filter by area id (uuid)' })
  @IsOptional()
  @IsUUID()
  areaId?: string;

  @ApiPropertyOptional({
    description: 'Lower bound (inclusive) on recorded_at — authoritative server time (ADR 0005)',
    example: '2026-08-07T00:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    description: 'Upper bound (inclusive) on recorded_at',
    example: '2026-08-08T00:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    description:
      'Opaque keyset cursor from a previous response (nextCursor). Encodes position only — ' +
      'filters are re-sent with every request; changing a filter mid-pagination is legal and ' +
      'continues from the same position under the new filter.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Page size',
    default: DEFAULT_LOGS_PAGE_SIZE,
    maximum: MAX_LOGS_PAGE_SIZE,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LOGS_PAGE_SIZE)
  limit: number = DEFAULT_LOGS_PAGE_SIZE;
}
