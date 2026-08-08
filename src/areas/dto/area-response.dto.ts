import { ApiProperty } from '@nestjs/swagger';

/**
 * Documentation model for the stored area as endpoints return it (the AreaEntity
 * shape on the wire). Closes the Phase 5 audit gap: /docs previously left the
 * area object's fields entirely undocumented.
 */
export class AreaResponseDto {
  @ApiProperty({ format: 'uuid', example: 'f7276e07-cc62-479b-acbd-2a2a361ba116' })
  id!: string;

  @ApiProperty({ example: 'Warehouse perimeter' })
  name!: string;

  @ApiProperty({ example: '2026-08-08T08:27:16.802Z' })
  createdAt!: string;

  @ApiProperty({
    description: 'GeoJSON Polygon exactly as stored; positions are [lng, lat]',
    example: {
      type: 'Polygon',
      coordinates: [
        [
          [28.97, 41.0],
          [28.99, 41.0],
          [28.99, 41.02],
          [28.97, 41.02],
          [28.97, 41.0],
        ],
      ],
    },
  })
  boundary!: Record<string, unknown>;
}
