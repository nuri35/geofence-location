import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiEnvelopedResponse } from '@app/common/decorators';
import { ErrorResponseDto } from '@app/common/dto';

import { ListLogsQueryDto, LogsPageResponseDto } from './dto';
import { LogsService } from './logs.service';

@ApiTags('logs')
@Controller('logs')
export class LogsController {
  constructor(private readonly logsService: LogsService) {}

  @Get()
  @ApiOperation({
    summary: 'Entry log, newest first, keyset-paginated (ADR 0006)',
    description:
      'Filters (userId, areaId, from/to on recorded_at) are optional and combinable, and are ' +
      're-sent with every request — the cursor encodes position only. Walk pages via nextCursor; ' +
      'null nextCursor means the last page.',
  })
  @ApiEnvelopedResponse(LogsPageResponseDto, {
    description: 'A page of log rows plus nextCursor, wrapped in the response envelope',
  })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Malformed cursor, invalid filter, or limit out of range',
  })
  list(@Query() query: ListLogsQueryDto): Promise<LogsPageResponseDto> {
    return this.logsService.list(query);
  }
}
