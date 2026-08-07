import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '@app/app.module';
import { AreasService } from '@app/areas/areas.service';

interface Envelope<T> {
  statusCode: number;
  timestamp: string;
  data: T;
}

interface AreaResponse {
  id: string;
  name: string;
  createdAt: string;
  boundary: { type: string; coordinates: number[][][] };
}

interface ErrorResponse {
  statusCode: number;
  message: string | string[];
}

const squarePolygon = (lngBase: number, latBase: number, size: number): object => ({
  type: 'Polygon',
  coordinates: [
    [
      [lngBase, latBase],
      [lngBase + size, latBase],
      [lngBase + size, latBase + size],
      [lngBase, latBase + size],
      [lngBase, latBase],
    ],
  ],
});

const circleRing = (distinctVertices: number): number[][] => {
  const ring: number[][] = [];
  for (let i = 0; i < distinctVertices; i += 1) {
    const angle = (2 * Math.PI * i) / distinctVertices;
    ring.push([10 + Math.cos(angle), 10 + Math.sin(angle)]);
  }
  ring.push([...ring[0]]);
  return ring;
};

const messageText = (body: ErrorResponse): string =>
  Array.isArray(body.message) ? body.message.join(' ') : body.message;

describe('Areas (e2e)', () => {
  let app: INestApplication<App>;
  let areasService: AreasService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // No manual pipe: AppModule provides APP_PIPE, so this harness validates exactly as prod does.
    await app.init();
    areasService = app.get(AreasService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a valid polygon with 201 and returns it as GeoJSON inside the envelope', async () => {
    const response = await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'valid-square', boundary: squarePolygon(28.9, 41.0, 0.1) })
      .expect(201);

    const body = response.body as Envelope<AreaResponse>;
    expect(body.statusCode).toBe(201);
    expect(body.data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.data.name).toBe('valid-square');
    expect(body.data.boundary.type).toBe('Polygon');
    expect(body.data.boundary.coordinates[0]).toHaveLength(5);
  });

  it('rejects a self-intersecting bowtie with 400 carrying ST_IsValidReason, storing nothing', async () => {
    const bowtie = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 10],
          [10, 0],
          [0, 10],
          [0, 0],
        ],
      ],
    };
    const response = await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'bowtie', boundary: bowtie })
      .expect(400);

    expect(messageText(response.body as ErrorResponse)).toContain('Self-intersection');

    const list = await request(app.getHttpServer()).get('/areas').expect(200);
    const areas = (list.body as Envelope<AreaResponse[]>).data;
    expect(areas.some((area) => area.name === 'bowtie')).toBe(false);
  });

  it('rejects an unclosed ring with 400 at the DTO layer', async () => {
    const response = await request(app.getHttpServer())
      .post('/areas')
      .send({
        name: 'unclosed',
        boundary: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [0, 1],
              [1, 1],
              [1, 0],
            ],
          ],
        },
      })
      .expect(400);

    expect(messageText(response.body as ErrorResponse)).toContain('not closed');
  });

  it('rejects out-of-range coordinates with 400', async () => {
    const outOfRange = [
      { lng: 0, lat: 91 },
      { lng: 181, lat: 0 },
      { lng: 0, lat: -91 },
    ];
    for (const { lng, lat } of outOfRange) {
      const response = await request(app.getHttpServer())
        .post('/areas')
        .send({
          name: 'out-of-range',
          boundary: {
            type: 'Polygon',
            coordinates: [
              [
                [lng, lat],
                [0, 1],
                [1, 1],
                [lng, lat],
              ],
            ],
          },
        })
        .expect(400);
      expect(messageText(response.body as ErrorResponse)).toContain('out of range');
    }
  });

  it('rejects 1001 distinct vertices and accepts 1000', async () => {
    await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'cap-1001', boundary: { type: 'Polygon', coordinates: [circleRing(1001)] } })
      .expect(400);

    await request(app.getHttpServer())
      .post('/areas')
      .send({ name: 'cap-1000', boundary: { type: 'Polygon', coordinates: [circleRing(1000)] } })
      .expect(201);
  });

  it('lists areas with limit/offset', async () => {
    const response = await request(app.getHttpServer()).get('/areas?limit=1&offset=0').expect(200);
    const areas = (response.body as Envelope<AreaResponse[]>).data;
    expect(areas).toHaveLength(1);
    expect(areas[0].boundary.type).toBe('Polygon');
  });

  it('rejects a non-numeric limit with 400', async () => {
    await request(app.getHttpServer()).get('/areas?limit=abc').expect(400);
  });

  describe('containment query (isolated — not wired to any endpoint this phase)', () => {
    let areaId: string;

    beforeAll(async () => {
      const response = await request(app.getHttpServer())
        .post('/areas')
        .send({ name: 'containment-square', boundary: squarePolygon(20, 20, 2) })
        .expect(201);
      areaId = (response.body as Envelope<AreaResponse>).data.id;
    });

    it('returns the area for a point inside it', async () => {
      await expect(areasService.findCoveringAreaIds(21, 21)).resolves.toContain(areaId);
    });

    it('does not return the area for a point outside it', async () => {
      await expect(areasService.findCoveringAreaIds(25, 25)).resolves.not.toContain(areaId);
    });

    it('returns the area for a point exactly on the boundary line (ST_Covers, decision 2)', async () => {
      // (21, 20) lies exactly on the bottom edge from (20,20) to (22,20).
      await expect(areasService.findCoveringAreaIds(21, 20)).resolves.toContain(areaId);
    });

    it('returns the area for a point exactly on a corner vertex', async () => {
      await expect(areasService.findCoveringAreaIds(20, 20)).resolves.toContain(areaId);
    });
  });
});
