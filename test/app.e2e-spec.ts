import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '@app/app.module';

describe('Health (e2e)', () => {
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

  it('GET /health returns the raw Terminus payload without the response envelope', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    const body = response.body as {
      status: string;
      info: Record<string, { status: string }>;
      error: Record<string, unknown>;
      details: Record<string, { status: string }>;
    };
    expect(body.status).toBe('ok');
    expect(body.info.database.status).toBe('up');
    expect(body.details.database.status).toBe('up');
    expect(body).not.toHaveProperty('data');
    expect(body).not.toHaveProperty('statusCode');
  });
});
