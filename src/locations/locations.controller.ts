import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';

import { ApiEnvelopedResponse } from '@app/common/decorators';
import { ErrorResponseDto } from '@app/common/dto';

import { LocationReportResponseDto, ReportLocationDto } from './dto';
import { LocationsService } from './locations.service';

@ApiTags('locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Post()
  @ApiOperation({ summary: 'Report a location; logs an entry event per newly entered area' })
  @ApiEnvelopedResponse(LocationReportResponseDto, {
    status: 201,
    description: '201 with the entries produced (decision 11), wrapped in the response envelope',
  })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Coordinate out of range, userId too long, or malformed observedAt',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponseDto,
    description:
      'Transient overload (pool acquire, statement ceiling — ADR 0009). Retry after the ' +
      'Retry-After value; retrying this endpoint is safe by construction.',
    headers: {
      'Retry-After': {
        description: 'Seconds to wait before retrying; chosen to land past the stall envelope',
        schema: { type: 'string', example: '5' },
      },
    },
  })
  report(@Body() dto: ReportLocationDto): Promise<LocationReportResponseDto> {
    return this.locationsService.report(dto);
  }
}
