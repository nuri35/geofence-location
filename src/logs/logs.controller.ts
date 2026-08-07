import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

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
  @ApiOkResponse({ type: LogsPageResponseDto })
  @ApiBadRequestResponse({ description: 'Malformed cursor, invalid filter, or limit out of range' })
  list(@Query() query: ListLogsQueryDto): Promise<LogsPageResponseDto> {
    return this.logsService.list(query);
  }
}
