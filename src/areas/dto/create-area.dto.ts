import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Polygon } from 'geojson';

import { IsGeoJsonPolygon } from './geojson-polygon.validation';

export class CreateAreaDto {
  @ApiProperty({
    description: 'Human-readable area name',
    maxLength: 255,
    example: 'Warehouse perimeter',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiProperty({
    description:
      'GeoJSON Polygon (RFC 7946, WGS84). Positions are [lng, lat] — longitude first. ' +
      'A swapped pair is numerically valid and silently relocates the polygon, so this ordering ' +
      'contract is the only defence; it is enforced nowhere else. Rings must be closed ' +
      '(last position repeats the first) and the polygon may carry at most 1000 distinct vertices. ' +
      'Geometric validity (no self-intersection) is checked server-side with ST_IsValid.',
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
  @IsGeoJsonPolygon()
  boundary!: Polygon;
}
