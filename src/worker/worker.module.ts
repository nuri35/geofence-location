import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AreasModule } from '@app/areas/areas.module';
import { LocationsService } from '@app/locations/locations.service';
import { PresenceMemoryService } from '@app/presence/presence-memory.service';
import { PresenceModule } from '@app/presence/presence.module';
import { RedisModule } from '@app/redis/redis.module';
import { appConfig } from '@config/app.config';
import { areasConfig } from '@config/areas.config';
import { databaseConfig } from '@config/database.config';
import { envValidationSchema } from '@config/env.validation';
import { mqConfig } from '@config/mq.config';
import { redisConfig } from '@config/redis.config';
import { typeOrmModuleFactory } from '@config/typeorm.config';
import { workerConfig } from '@config/worker.config';

import { WorkerConsumerService } from './worker-consumer.service';

/**
 * The worker process (ADR 0016): same repository and modules as the API, separate
 * entrypoint (worker-main.ts), independently scalable. Mounts the transition path
 * N4B parked (LocationsService) plus the in-memory spatial snapshot with its
 * version polling (AreasModule) — the worker now owns per-event evaluation.
 * No HTTP, no controllers.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, areasConfig, databaseConfig, mqConfig, redisConfig, workerConfig],
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: true,
      },
    }),
    TypeOrmModule.forRootAsync({
      inject: [databaseConfig.KEY],
      useFactory: typeOrmModuleFactory,
    }),
    RedisModule,
    AreasModule,
    PresenceModule,
  ],
  // PresenceMemoryService is provided HERE and nowhere else (ADR 0018): only the
  // worker may hold per-user presence memory — the API is multi-instance and a
  // memory there would be split-brain. LocationsService takes it @Optional().
  providers: [LocationsService, WorkerConsumerService, PresenceMemoryService],
})
export class WorkerModule {}
