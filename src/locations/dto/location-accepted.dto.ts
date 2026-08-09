import { ApiProperty } from '@nestjs/swagger';

/**
 * The N4B ingestion acknowledgement (ADR 0015): the event is durably queued, not
 * yet processed. There is deliberately no `enteredAreaIds` — nothing has computed
 * them at response time.
 */
export class LocationAcceptedDto {
  @ApiProperty({
    description:
      'Server-assigned id of the accepted location event. Processing is asynchronous: ' +
      'a resulting entry appears in GET /logs only after a worker consumes the event.',
    example: '0b9c9f3e-6d1f-4a3a-9c37-8f6a2f6d4e11',
  })
  eventId!: string;
}
