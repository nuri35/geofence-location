import { ApiProperty } from '@nestjs/swagger';

export class LocationReportResponseDto {
  @ApiProperty({
    description:
      'Areas this request produced an entry for (decision 11). Empty when nothing happened. ' +
      'Ids correspond one-to-one with the log rows the request created.',
    type: [String],
  })
  enteredAreaIds!: string[];
}
