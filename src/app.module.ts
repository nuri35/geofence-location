import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AreasModule } from '@app/areas/areas.module';
import { HttpExceptionFilter } from '@app/common/filters';
import { ResponseTransformInterceptor } from '@app/common/interceptors';
import { HealthModule } from '@app/health/health.module';
import { RedisModule } from '@app/redis/redis.module';
import { appConfig } from '@config/app.config';
import { databaseConfig } from '@config/database.config';
import { envValidationSchema } from '@config/env.validation';
import { redisConfig } from '@config/redis.config';
import { typeOrmModuleFactory } from '@config/typeorm.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig],
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: true,
      },
    }),
    TypeOrmModule.forRootAsync({
      inject: [databaseConfig.KEY],
      useFactory: typeOrmModuleFactory,
    }),
    AreasModule,
    RedisModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseTransformInterceptor,
    },
  ],
})
export class AppModule {}
