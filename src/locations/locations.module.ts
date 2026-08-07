import { Module } from '@nestjs/common';

import { AreasModule } from '@app/areas/areas.module';

import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';

@Module({
  imports: [AreasModule],
  controllers: [LocationsController],
  providers: [LocationsService],
})
export class LocationsModule {}
