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
          // A sick Redis must not hurt the request path (decision 6): fail fast, never queue.
          commandTimeout: 100,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 1000,
          retryStrategy: (times: number): number => Math.min(times * 200, 2000),
        }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // quit() needs a live connection; with Redis down, force-close the socket instead.
      this.client.disconnect();
    }
  }
}
