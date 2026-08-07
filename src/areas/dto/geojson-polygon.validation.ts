import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

import { MAX_POLYGON_VERTICES } from '../areas.constants';

const LNG_RANGE = 180;
const LAT_RANGE = 90;
const MIN_RING_POSITIONS = 4;

/**
 * Returns a human-readable reason the value is not an acceptable GeoJSON Polygon,
 * or null when it is. Structural checks only — geometric validity (self-intersection)
 * is PostGIS's job via ST_IsValid, which cannot be replicated faithfully here.
 */
export const geoJsonPolygonFailure = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null) {
    return 'boundary must be a GeoJSON Polygon object';
  }
  const polygon = value as { type?: unknown; coordinates?: unknown };
  if (polygon.type !== 'Polygon') {
    return "boundary.type must be 'Polygon'";
  }
  if (!Array.isArray(polygon.coordinates) || polygon.coordinates.length === 0) {
    return 'boundary.coordinates must be a non-empty array of linear rings';
  }
  let vertexCount = 0;
  for (let ringIndex = 0; ringIndex < polygon.coordinates.length; ringIndex += 1) {
    const ring: unknown = polygon.coordinates[ringIndex];
    if (!Array.isArray(ring) || ring.length < MIN_RING_POSITIONS) {
      return `ring ${ringIndex} must be an array of at least ${MIN_RING_POSITIONS} positions (a closed ring repeats its first position last)`;
    }
    for (let positionIndex = 0; positionIndex < ring.length; positionIndex += 1) {
      const position: unknown = ring[positionIndex];
      if (!Array.isArray(position) || position.length !== 2) {
        return `ring ${ringIndex} position ${positionIndex} must be a [lng, lat] pair`;
      }
      const [lng, lat] = position as [unknown, unknown];
      if (
        typeof lng !== 'number' ||
        !Number.isFinite(lng) ||
        typeof lat !== 'number' ||
        !Number.isFinite(lat)
      ) {
        return `ring ${ringIndex} position ${positionIndex} must contain finite numbers`;
      }
      if (Math.abs(lng) > LNG_RANGE) {
        return `ring ${ringIndex} position ${positionIndex}: longitude ${lng} out of range [-180, 180] — coordinates are [lng, lat]`;
      }
      if (Math.abs(lat) > LAT_RANGE) {
        return `ring ${ringIndex} position ${positionIndex}: latitude ${lat} out of range [-90, 90] — coordinates are [lng, lat]`;
      }
    }
    const first = ring[0] as [number, number];
    const last = ring[ring.length - 1] as [number, number];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      return `ring ${ringIndex} is not closed: the last position must repeat the first`;
    }
    vertexCount += ring.length - 1;
  }
  if (vertexCount > MAX_POLYGON_VERTICES) {
    return `polygon has ${vertexCount} vertices; the maximum is ${MAX_POLYGON_VERTICES} (closing repeats excluded)`;
  }
  return null;
};

export function IsGeoJsonPolygon(
  validationOptions?: ValidationOptions,
): (object: object, propertyName: string) => void {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isGeoJsonPolygon',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return geoJsonPolygonFailure(value) === null;
        },
        defaultMessage(args: ValidationArguments): string {
          return geoJsonPolygonFailure(args.value) ?? 'boundary is not a valid GeoJSON Polygon';
        },
      },
    });
  };
}
