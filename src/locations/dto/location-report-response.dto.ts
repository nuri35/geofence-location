import { ApiProperty } from '@nestjs/swagger';

export class LocationReportResponseDto {
  @ApiProperty({
    description:
      'Areas this request produced an entry for (decision 11). Empty when nothing happened. ' +
      'Ids correspond one-to-one with the log rows the request created.',
    type: [String],
  })
  enteredAreaIds!: string[];

  @ApiProperty({
    description:
      'True when this event was already processed for this (userId, deviceId) — the seq was ' +
      'not newer than the last handled one (ADR 0010). Not an error: the client did nothing ' +
      'wrong and the original processing stands. Duplicates return HTTP 200, fresh events 201.',
  })
  duplicate!: boolean;
}
