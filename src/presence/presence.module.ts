import { Module } from '@nestjs/common';

import { MetricsController } from './metrics.controller';
import { PresenceCacheService } from './presence-cache.service';
import { PresenceMetricsService } from './presence-metrics.service';

@Module({
  controllers: [MetricsController],
  providers: [PresenceCacheService, PresenceMetricsService],
  exports: [PresenceCacheService, PresenceMetricsService],
})
export class PresenceModule {}
