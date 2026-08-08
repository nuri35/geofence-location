import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiEnvelopedResponse } from '@app/common/decorators';
import { ErrorResponseDto } from '@app/common/dto';

import { AreasService } from './areas.service';
import { AreaResponseDto, CreateAreaDto, ListAreasQueryDto } from './dto';
import { AreaEntity } from './entities/area.entity';

@ApiTags('areas')
@Controller('areas')
export class AreasController {
  constructor(private readonly areasService: AreasService) {}

  @Post()
  @ApiOperation({ summary: 'Create a geofence area from a GeoJSON Polygon' })
  @ApiEnvelopedResponse(AreaResponseDto, {
    status: 201,
    description: 'Area stored; boundary returned as GeoJSON, wrapped in the response envelope',
  })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description:
      'Structural failure (coordinate range, ring closure, vertex cap — detailed message) or ' +
      'geometric invalidity (message carries the ST_IsValidReason output, e.g. "Self-intersection[5 5]")',
  })
  create(@Body() dto: CreateAreaDto): Promise<AreaEntity> {
    return this.areasService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List areas with full GeoJSON geometry (limit/offset per ADR 0006)' })
  @ApiEnvelopedResponse(AreaResponseDto, {
    isArray: true,
    description: 'Areas ordered by creation time, wrapped in the response envelope',
  })
  @ApiBadRequestResponse({ type: ErrorResponseDto, description: 'limit/offset out of range' })
  findAll(@Query() query: ListAreasQueryDto): Promise<AreaEntity[]> {
    return this.areasService.findAll(query);
  }
}
