import { HealthCheckResult, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { Test, TestingModule } from '@nestjs/testing';

import { REDIS_CLIENT } from '@app/redis/redis.constants';

import { HEALTH_INDICATOR_DATABASE, HEALTH_INDICATOR_REDIS } from './health.constants';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  const baseResult = (): HealthCheckResult => ({
    status: 'ok',
    info: { [HEALTH_INDICATOR_DATABASE]: { status: 'up' } },
    error: {},
    details: { [HEALTH_INDICATOR_DATABASE]: { status: 'up' } },
  });

  const healthCheckService = {
    check: jest.fn(),
  };

  const typeOrmHealthIndicator = {
    pingCheck: jest.fn().mockResolvedValue({ [HEALTH_INDICATOR_DATABASE]: { status: 'up' } }),
  };

  const redisClient = {
    ping: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    healthCheckService.check.mockResolvedValue(baseResult());
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: healthCheckService },
        { provide: TypeOrmHealthIndicator, useValue: typeOrmHealthIndicator },
        { provide: REDIS_CLIENT, useValue: redisClient },
      ],
    }).compile();

    controller = module.get(HealthController);
  });

  it('reports redis up alongside the database result', async () => {
    redisClient.ping.mockResolvedValue('PONG');

    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(result.info?.[HEALTH_INDICATOR_DATABASE]).toEqual({ status: 'up' });
    expect(result.info?.[HEALTH_INDICATOR_REDIS]).toEqual({ status: 'up' });
    expect(result.details[HEALTH_INDICATOR_REDIS]).toEqual({ status: 'up' });
  });

  it('keeps overall status ok while reporting redis down (decision 6: not critical path)', async () => {
    redisClient.ping.mockRejectedValue(new Error('connection refused'));

    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(result.info?.[HEALTH_INDICATOR_REDIS]).toEqual({ status: 'down' });
    expect(result.details[HEALTH_INDICATOR_REDIS]).toEqual({ status: 'down' });
  });
});
