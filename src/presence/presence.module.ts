import { Module } from '@nestjs/common';

import { PresenceCacheService } from './presence-cache.service';

@Module({
  providers: [PresenceCacheService],
  exports: [PresenceCacheService],
})
export class PresenceModule {}
