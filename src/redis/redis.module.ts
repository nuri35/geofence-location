import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';

import { redisConfig } from '@config/redis.config';

import { REDIS_CLIENT } from './redis.constants';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [redisConfig.KEY],
      useFactory: (redis: ConfigType<typeof redisConfig>): Redis =>
        new Redis({
          host: redis.host,
          port: redis.port,
          ...(redis.password.length > 0 ? { password: redis.password } : {}),
        }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.quit();
  }
}
