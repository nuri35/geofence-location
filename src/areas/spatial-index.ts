import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { Polygon } from 'geojson';
import RBush from 'rbush';

export interface AreaGeometryRow {
  id: string;
  boundary: Polygon;
}

interface IndexedArea {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
  boundary: Polygon;
}

/** Bbox from the outer ring only — interior rings (holes) lie inside it by definition. */
const toIndexedArea = (row: AreaGeometryRow): IndexedArea => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lng, lat] of row.boundary.coordinates[0]) {
    if (lng < minX) minX = lng;
    if (lng > maxX) maxX = lng;
    if (lat < minY) minY = lat;
    if (lat > maxY) maxY = lat;
  }
  return { minX, minY, maxX, maxY, id: row.id, boundary: row.boundary };
};

/**
 * Pure in-memory point-in-polygon: rbush bbox prefilter + exact turf containment —
 * the same two-stage shape the GIST index executes (bbox operator + recheck), in Node.
 * No Nest, no database: this class is what moves into the N4 worker unchanged.
 * Boundary semantics are ST_Covers (the boundary line counts as inside, decision 2):
 * booleanPointInPolygon with ignoreBoundary: false, proven equivalent against the
 * real PostGIS query by test/spatial-equivalence.e2e-spec.ts.
 */
export class AreaSpatialIndex {
  private readonly tree = new RBush<IndexedArea>();
  readonly areaCount: number;

  constructor(rows: AreaGeometryRow[]) {
    this.tree.load(rows.map(toIndexedArea));
    this.areaCount = rows.length;
  }

  findCoveringAreaIds(lng: number, lat: number): string[] {
    return this.tree
      .search({ minX: lng, minY: lat, maxX: lng, maxY: lat })
      .filter((entry) =>
        booleanPointInPolygon([lng, lat], entry.boundary, { ignoreBoundary: false }),
      )
      .map((entry) => entry.id);
  }
}
