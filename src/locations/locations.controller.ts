import { Body, Controller, HttpStatus, Post, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Response } from 'express';

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
    description: 'Fresh event processed; entries produced (decision 11), wrapped in the envelope',
  })
  @ApiEnvelopedResponse(LocationReportResponseDto, {
    status: 200,
    description:
      'Duplicate event (seq not newer than the last processed for this userId+deviceId) — ' +
      'acknowledged without reprocessing, duplicate: true (ADR 0010)',
  })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description:
      'Malformed input: coordinate out of range, userId too long, deviceId/seq sent without the other, bad date',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorResponseDto,
    description: `Well-formed but unusable: GPS accuracy above the usable maximum (ADR 0010)`,
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
  async report(
    @Body() dto: ReportLocationDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LocationReportResponseDto> {
    const result = await this.locationsService.report(dto);
    if (result.duplicate) {
      // Not an error and not a creation: the event was genuinely already handled.
      response.status(HttpStatus.OK);
    }
    return result;
  }
}
