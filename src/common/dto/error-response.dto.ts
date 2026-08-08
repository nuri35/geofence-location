import { ApiProperty } from '@nestjs/swagger';

/**
 * The house error shape (AllExceptionsFilter) — every error this API produces,
 * including validation 400s (message becomes string[]), 404s, 413s, timeouts
 * (503 + Retry-After, ADR 0009) and internal 500s. NOT wrapped in the envelope.
 */
export class ErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: '2026-08-08T08:34:34.826Z' })
  timestamp!: string;

  @ApiProperty({ example: '/locations' })
  path!: string;

  @ApiProperty({
    description: 'A string, or an array of strings for validation failures',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  })
  message!: string | string[];
}
