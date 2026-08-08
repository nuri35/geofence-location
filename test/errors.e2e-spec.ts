import { INestApplication } from '@nestjs/common';
import { HealthCheckError, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '@app/app.module';

interface HouseError {
  statusCode: number;
  timestamp: string;
  path: string;
  message: string | string[];
}

describe('Error contract (e2e)', () => {
  describe('with the real app', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleFixture.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('validation error: house shape with the validator messages', async () => {
      const response = await request(app.getHttpServer())
        .post('/locations')
        .send({ userId: 'u', lng: 0, lat: 91 })
        .expect(400);
      const body = response.body as HouseError;
      expect(body.statusCode).toBe(400);
      expect(body.path).toBe('/locations');
      expect(typeof body.timestamp).toBe('string');
      expect(Array.isArray(body.message)).toBe(true);
    });

    it('404 on an unknown route: house shape', async () => {
      const response = await request(app.getHttpServer()).get('/definitely-not-here').expect(404);
      const body = response.body as HouseError;
      expect(body).toMatchObject({ statusCode: 404, path: '/definitely-not-here' });
      expect(typeof body.timestamp).toBe('string');
    });

    it('malformed JSON body: house shape, 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/locations')
        .set('content-type', 'application/json')
        .send('{"userId": bad')
        .expect(400);
      const body = response.body as HouseError;
      expect(body.statusCode).toBe(400);
      expect(body.path).toBe('/locations');
      expect(typeof body.timestamp).toBe('string');
    });

    it('oversized body: house shape, 413 — previously escaped the filter entirely', async () => {
      const response = await request(app.getHttpServer())
        .post('/locations')
        .set('content-type', 'application/json')
        .send(JSON.stringify({ userId: 'u', lng: 0, lat: 0, pad: 'a'.repeat(200 * 1024) }))
        .expect(413);
      const body = response.body as HouseError;
      expect(body).toMatchObject({ statusCode: 413, path: '/locations' });
      expect(typeof body.timestamp).toBe('string');
    });

    it('healthy GET /health is unchanged: raw Terminus body, no envelope, no house shape', async () => {
      const response = await request(app.getHttpServer()).get('/health').expect(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        details: { database: { status: 'up' } },
      });
      expect(response.body).not.toHaveProperty('path');
      expect(response.body).not.toHaveProperty('data');
    });
  });

  describe('with a failing database probe (real Terminus + real filter, probe overridden)', () => {
    // Stopping the shared Postgres container here would kill the parallel suites, so the
    // indicator is overridden to fail the way the real one does. This proves the
    // structured 503 survives the filter through the real HTTP stack; that the shape
    // holds when Postgres is ACTUALLY unreachable is verified by hand against the prod
    // artifact (recorded in the Phase 4B report).
    let app: INestApplication<App>;

    beforeAll(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(TypeOrmHealthIndicator)
        .useValue({
          pingCheck: (key: string): Promise<never> =>
            Promise.reject(
              new HealthCheckError('pingCheck failed', {
                [key]: { status: 'down', message: 'connect ECONNREFUSED 127.0.0.1:5433' },
              }),
            ),
        })
        .compile();
      app = moduleFixture.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('unhealthy GET /health keeps the per-indicator detail through the 503', async () => {
      const response = await request(app.getHttpServer()).get('/health').expect(503);
      const body = response.body as {
        status: string;
        error: Record<string, { status: string }>;
        details: Record<string, { status: string }>;
      };
      expect(body.status).toBe('error');
      expect(body.error.database.status).toBe('down');
      expect(body.details.database.status).toBe('down');
      // and NOT the flattened shape the smoke test caught:
      expect(response.body).not.toMatchObject({ message: 'Service Unavailable Exception' });
    });
  });
});
