import { ApiProperty } from '@nestjs/swagger';

/**
 * The wire shape every wrapped endpoint actually returns (ResponseTransformInterceptor,
 * global since Phase 0). Documentation base only — the `data` property is typed per
 * endpoint by the ApiEnvelopedResponse decorator; this class is never instantiated.
 */
export class ResponseEnvelopeDto {
  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: '2026-08-08T08:34:34.826Z', description: 'Set at request receipt' })
  timestamp!: string;
}
