import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AreaSnapshotService } from './area-snapshot.service';
import { AreasController } from './areas.controller';
import { AreasService } from './areas.service';
import { AreaEntity } from './entities/area.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AreaEntity])],
  controllers: [AreasController],
  providers: [AreasService, AreaSnapshotService],
  exports: [AreasService],
})
export class AreasModule {}
