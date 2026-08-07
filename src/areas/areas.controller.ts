import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AreasService } from './areas.service';
import { CreateAreaDto, ListAreasQueryDto } from './dto';
import { AreaEntity } from './entities/area.entity';

@ApiTags('areas')
@Controller('areas')
export class AreasController {
  constructor(private readonly areasService: AreasService) {}

  @Post()
  @ApiOperation({ summary: 'Create a geofence area from a GeoJSON Polygon' })
  @ApiCreatedResponse({ description: 'Area stored; boundary returned as GeoJSON' })
  @ApiBadRequestResponse({
    description:
      'Structural failure (coordinate range, ring closure, vertex cap — detailed message) or ' +
      'geometric invalidity (400 carries the ST_IsValidReason output, e.g. "Self-intersection[5 5]")',
  })
  create(@Body() dto: CreateAreaDto): Promise<AreaEntity> {
    return this.areasService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List areas with full GeoJSON geometry (limit/offset per ADR 0006)' })
  @ApiOkResponse({ description: 'Areas ordered by creation time' })
  findAll(@Query() query: ListAreasQueryDto): Promise<AreaEntity[]> {
    return this.areasService.findAll(query);
  }
}
