import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import Redis from 'ioredis';

import { SkipResponseTransform } from '@app/common/decorators';
import { REDIS_CLIENT } from '@app/redis/redis.constants';

import { HEALTH_INDICATOR_DATABASE, HEALTH_INDICATOR_REDIS } from './health.constants';

@ApiTags('health')
@SkipResponseTransform()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  @HealthCheck()
  async check(): Promise<HealthCheckResult> {
    // Only the database is critical: its failure 503s via Terminus. Redis is a
    // performance layer (decision 6), so its status is merged in afterwards — reported
    // honestly, but a Redis outage must never fail the endpoint.
    const result = await this.health.check([
      (): Promise<HealthIndicatorResult> => this.db.pingCheck(HEALTH_INDICATOR_DATABASE),
    ]);

    const redisStatus = await this.redisStatus();
    result.info = { ...result.info, [HEALTH_INDICATOR_REDIS]: redisStatus };
    result.details = { ...result.details, [HEALTH_INDICATOR_REDIS]: redisStatus };
    return result;
  }

  private async redisStatus(): Promise<{ status: 'up' | 'down' }> {
    try {
      await this.redis.ping();
      return { status: 'up' };
    } catch {
      return { status: 'down' };
    }
  }
}
