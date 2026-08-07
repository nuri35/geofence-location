import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { DEFAULT_AREAS_PAGE_SIZE, MAX_AREAS_PAGE_SIZE } from '../areas.constants';

export class ListAreasQueryDto {
  @ApiPropertyOptional({
    description: 'Page size (limit/offset is deliberate here — ADR 0006)',
    default: DEFAULT_AREAS_PAGE_SIZE,
    maximum: MAX_AREAS_PAGE_SIZE,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_AREAS_PAGE_SIZE)
  limit: number = DEFAULT_AREAS_PAGE_SIZE;

  @ApiPropertyOptional({ description: 'Rows to skip', default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
