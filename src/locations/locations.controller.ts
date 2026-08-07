import { Body, Controller, Post } from '@nestjs/common';
import { ApiBadRequestResponse, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { LocationReportResponseDto, ReportLocationDto } from './dto';
import { LocationsService } from './locations.service';

@ApiTags('locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Post()
  @ApiOperation({ summary: 'Report a location; logs an entry event per newly entered area' })
  @ApiCreatedResponse({
    type: LocationReportResponseDto,
    description: '201 with the entries produced (decision 11)',
  })
  @ApiBadRequestResponse({
    description: 'Coordinate out of range, userId too long, or malformed observedAt',
  })
  report(@Body() dto: ReportLocationDto): Promise<LocationReportResponseDto> {
    return this.locationsService.report(dto);
  }
}
