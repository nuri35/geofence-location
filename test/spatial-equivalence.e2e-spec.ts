import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '@app/app.module';
import { AreasService } from '@app/areas/areas.service';

/**
 * The Phase N2 gate (ADR 0012): every probe point runs through BOTH the PostGIS
 * ST_Covers query (findCoveringAreaIdsViaPostgis) and the in-memory rbush+turf
 * index (findCoveringAreaIds) and the answers must be identical. The point set
 * deliberately lands on boundary lines, vertices, epsilon-offsets, holes, shared
 * edges and overlaps — the cases nobody tests. Keep this spec forever: it is the
 * tripwire for a turf or PostGIS upgrade silently changing boundary semantics.
 *
 * Coordinate plane claim (see testing-verification skill): lng 59..81.
 */

type Ring = Array<[number, number]>;

interface PolygonFixture {
  name: string;
  rings: Ring[];
}

interface Mismatch {
  lng: number;
  lat: number;
  postgis: string[];
  memory: string[];
}

// --- fixtures -------------------------------------------------------------

const closed = (points: Ring): Ring => [...points, points[0]];

const FIXTURES: PolygonFixture[] = [
  {
    name: 'eq-axis-square',
    rings: [
      closed([
        [60, 2],
        [62, 2],
        [62, 4],
        [60, 4],
      ]),
    ],
  },
  {
    name: 'eq-overlapping-square',
    rings: [
      closed([
        [61, 3],
        [63, 3],
        [63, 5],
        [61, 5],
      ]),
    ],
  },
  {
    name: 'eq-diamond',
    rings: [
      closed([
        [65, 3.5],
        [66.5, 5],
        [65, 6.5],
        [63.5, 5],
      ]),
    ],
  },
  {
    name: 'eq-concave-L',
    rings: [
      closed([
        [68, 0],
        [72, 0],
        [72, 2],
        [70, 2],
        [70, 4],
        [68, 4],
      ]),
    ],
  },
  {
    name: 'eq-square-with-hole',
    rings: [
      closed([
        [74, 0],
        [77, 0],
        [77, 3],
        [74, 3],
      ]),
      closed([
        [75, 1],
        [76, 1],
        [76, 2],
        [75, 2],
      ]),
    ],
  },
  {
    name: 'eq-awkward-triangle',
    rings: [
      closed([
        [78, 0],
        [79.3, 2.7],
        [78.1, 0.9],
      ]),
    ],
  },
  {
    name: 'eq-adjacent-west',
    rings: [
      closed([
        [63, 8],
        [64, 8],
        [64, 10],
        [63, 10],
      ]),
    ],
  },
  {
    name: 'eq-adjacent-east',
    rings: [
      closed([
        [64, 8],
        [65, 8],
        [65, 10],
        [64, 10],
      ]),
    ],
  },
];

// --- deterministic probe points --------------------------------------------

const buildProbePoints = (): Array<[number, number]> => {
  const points: Array<[number, number]> = [];
  const push = (lng: number, lat: number): void => {
    points.push([lng, lat]);
  };

  for (const fixture of FIXTURES) {
    for (const ring of fixture.rings) {
      for (let i = 0; i < ring.length - 1; i += 1) {
        const [ax, ay] = ring[i];
        const [bx, by] = ring[i + 1];
        // Vertices — exactly on the boundary.
        push(ax, ay);
        // Points along the segment: midpoint plus non-representable fractions.
        for (const t of [0.5, 1 / 3, 1 / 7]) {
          push(ax + (bx - ax) * t, ay + (by - ay) * t);
        }
        // Epsilon-perpendicular offsets from the midpoint: just inside / just outside.
        const mx = ax + (bx - ax) * 0.5;
        const my = ay + (by - ay) * 0.5;
        const len = Math.hypot(bx - ax, by - ay);
        const nx = -(by - ay) / len;
        const ny = (bx - ax) / len;
        for (const eps of [1e-9, 1e-12, -1e-9, -1e-12]) {
          push(mx + nx * eps, my + ny * eps);
        }
      }
    }
    // Bbox corners and center of the outer ring.
    const outer = fixture.rings[0];
    const lngs = outer.map(([lng]) => lng);
    const lats = outer.map(([, lat]) => lat);
    const [minX, maxX] = [Math.min(...lngs), Math.max(...lngs)];
    const [minY, maxY] = [Math.min(...lats), Math.max(...lats)];
    push(minX, minY);
    push(maxX, maxY);
    push(minX, maxY);
    push(maxX, minY);
    push((minX + maxX) / 2, (minY + maxY) / 2);
  }

  // Hole center (must be outside) and points on the hole's ring handled above.
  push(75.5, 1.5);
  // Shared-edge probes between the adjacent squares.
  push(64, 9);
  push(64, 8);
  push(64, 10);
  // Overlap interior (covered by both squares).
  push(61.5, 3.5);
  // Far outside everything.
  push(59, -0.5);
  push(81, 11);

  // Deterministic 23×23 grid across the whole claimed plane.
  for (let i = 0; i <= 22; i += 1) {
    for (let j = 0; j <= 22; j += 1) {
      push(59 + (i * 22) / 22, -1 + (j * 12) / 22);
    }
  }

  return points;
};

// --- the comparison ---------------------------------------------------------

describe('Spatial equivalence: in-memory index vs PostGIS ST_Covers (e2e)', () => {
  let app: INestApplication<App>;
  let areasService: AreasService;
  const fixtureIds = new Set<string>();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    areasService = app.get(AreasService);

    for (const fixture of FIXTURES) {
      const response = await request(app.getHttpServer())
        .post('/areas')
        .send({ name: fixture.name, boundary: { type: 'Polygon', coordinates: fixture.rings } })
        .expect(201);
      fixtureIds.add((response.body as { data: { id: string } }).data.id);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers identically for every boundary, vertex, epsilon-offset, hole and grid point', async () => {
    const probePoints = buildProbePoints();
    expect(probePoints.length).toBeGreaterThan(800);

    const mismatches: Mismatch[] = [];
    for (const [lng, lat] of probePoints) {
      const postgis = (await areasService.findCoveringAreaIdsViaPostgis(lng, lat))
        .filter((id) => fixtureIds.has(id))
        .sort();
      const memory = (await areasService.findCoveringAreaIds(lng, lat))
        .filter((id) => fixtureIds.has(id))
        .sort();
      if (JSON.stringify(postgis) !== JSON.stringify(memory)) {
        mismatches.push({ lng, lat, postgis, memory });
      }
    }

    expect(mismatches).toEqual([]);
  }, 120_000);

  it('sanity: the point set actually exercises agreement on covered points, not just empty-vs-empty', async () => {
    // Guards against a harness bug where both sides return [] everywhere.
    const covered = await areasService.findCoveringAreaIds(61, 3);
    expect(covered.filter((id) => fixtureIds.has(id)).length).toBeGreaterThanOrEqual(1);
  });
});
