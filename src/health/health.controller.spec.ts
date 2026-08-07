import { HealthCheckResult, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { Test, TestingModule } from '@nestjs/testing';

import { HEALTH_INDICATOR_DATABASE } from './health.constants';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  const healthCheckResult: HealthCheckResult = {
    status: 'ok',
    info: { [HEALTH_INDICATOR_DATABASE]: { status: 'up' } },
    error: {},
    details: { [HEALTH_INDICATOR_DATABASE]: { status: 'up' } },
  };

  const healthCheckService = {
    check: jest.fn().mockResolvedValue(healthCheckResult),
  };

  const typeOrmHealthIndicator = {
    pingCheck: jest.fn().mockResolvedValue({ [HEALTH_INDICATOR_DATABASE]: { status: 'up' } }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: healthCheckService },
        { provide: TypeOrmHealthIndicator, useValue: typeOrmHealthIndicator },
      ],
    }).compile();

    controller = module.get(HealthController);
  });

  it('returns the aggregated health check result', async () => {
    await expect(controller.check()).resolves.toEqual(healthCheckResult);
    expect(healthCheckService.check).toHaveBeenCalled();
  });
});
