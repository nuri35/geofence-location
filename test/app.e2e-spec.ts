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

  it('GET /health reports the database as up inside the response envelope', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    const body = response.body as {
      statusCode: number;
      timestamp: string;
      data: { status: string; info: Record<string, { status: string }> };
    };
    expect(body.statusCode).toBe(200);
    expect(body.data.status).toBe('ok');
    expect(body.data.info.database.status).toBe('up');
  });
});
