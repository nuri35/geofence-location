import { Module } from '@nestjs/common';

import { AreasModule } from '@app/areas/areas.module';
import { MqModule } from '@app/mq/mq.module';
import { PresenceModule } from '@app/presence/presence.module';

import { LocationsController } from './locations.controller';
import { LocationIngestService } from './location-ingest.service';
import { LocationsService } from './locations.service';

@Module({
  imports: [AreasModule, PresenceModule, MqModule],
  controllers: [LocationsController],
  // LocationsService is deliberately still provided although no controller calls
  // it since N4B: it is the transition processor N4C mounts in the worker, kept
  // alive by its unit suite and the service-level e2e specs (ADR 0015).
  providers: [LocationIngestService, LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
