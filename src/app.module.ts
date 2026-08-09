import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AreasModule } from '@app/areas/areas.module';
import { AllExceptionsFilter } from '@app/common/filters';
import { ResponseTransformInterceptor } from '@app/common/interceptors';
import { HealthModule } from '@app/health/health.module';
import { LocationsModule } from '@app/locations/locations.module';
import { LogsModule } from '@app/logs/logs.module';
import { RedisModule } from '@app/redis/redis.module';
import { appConfig } from '@config/app.config';
import { areasConfig } from '@config/areas.config';
import { databaseConfig } from '@config/database.config';
import { mqConfig } from '@config/mq.config';
import { redisConfig } from '@config/redis.config';
import { envValidationSchema } from '@config/env.validation';
import { typeOrmModuleFactory } from '@config/typeorm.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, areasConfig, databaseConfig, mqConfig, redisConfig],
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
    LocationsModule,
    LogsModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseTransformInterceptor,
    },
    {
      // Module-provided so the e2e harness gets the exact pipe production runs —
      // a main.ts registration is invisible to Test.createTestingModule and drifts.
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule {}
