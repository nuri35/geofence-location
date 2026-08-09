import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { ApiEnvelopedResponse } from '@app/common/decorators';
import { ErrorResponseDto } from '@app/common/dto';

import { LocationAcceptedDto, ReportLocationDto } from './dto';
import { LocationIngestService } from './location-ingest.service';

@ApiTags('locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly ingestService: LocationIngestService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Accept a location event for asynchronous processing (N4B, ADR 0015)',
    description:
      'Validates, stamps receivedAt, publishes to the partitioned queue, and returns 202 ' +
      'with the eventId. Processing is EVENTUALLY CONSISTENT: after a successful response, ' +
      'a resulting entry may not appear in GET /logs until a worker has consumed the event — ' +
      'this is expected behaviour, not a bug. The response carries no enteredAreaIds because ' +
      'nothing has computed them at response time (the pre-N4 contract, decision 11, is retired).',
  })
  @ApiEnvelopedResponse(LocationAcceptedDto, {
    status: 202,
    description:
      'Event durably queued (publisher-confirmed). Entries, if any, appear in GET /logs ' +
      'after asynchronous processing — eventual consistency by design.',
  })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description:
      'Malformed input: coordinate out of range, userId too long, deviceId/seq sent without the other, bad date',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorResponseDto,
    description: 'Well-formed but unusable: GPS accuracy above the usable maximum (ADR 0010)',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponseDto,
    description:
      'The event could NOT be durably queued (broker unavailable or publish unconfirmed — ' +
      'ADR 0015) or a transient database bound fired (ADR 0009). Nothing was stored; retry ' +
      'after the Retry-After value. Retrying is safe: the adaptive client re-sends its ' +
      'position on the next ping anyway.',
    headers: {
      'Retry-After': {
        description: 'Seconds to wait before retrying',
        schema: { type: 'string', example: '5' },
      },
    },
  })
  report(@Body() dto: ReportLocationDto): Promise<LocationAcceptedDto> {
    return this.ingestService.accept(dto);
  }
}
