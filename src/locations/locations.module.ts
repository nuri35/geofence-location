import { Module } from '@nestjs/common';

import { AreasModule } from '@app/areas/areas.module';
import { PresenceModule } from '@app/presence/presence.module';

import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';

@Module({
  imports: [AreasModule, PresenceModule],
  controllers: [LocationsController],
  providers: [LocationsService],
})
export class LocationsModule {}
