import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';

import { redisConfig } from '@config/redis.config';

import { REDIS_CLIENT } from './redis.constants';

/**
 * Restored from the ADR 0007-era module (git 5afbf21^) for ADR 0013. The client is
 * tuned so a sick Redis costs bounded latency, never availability: commands fail
 * fast instead of queueing, and every caller treats a Redis error as a cache miss
 * that must not write back.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [redisConfig.KEY],
      useFactory: (redis: ConfigType<typeof redisConfig>): Redis => {
        const client = new Redis({
          host: redis.host,
          port: redis.port,
          ...(redis.password.length > 0 ? { password: redis.password } : {}),
          // A sick Redis must not hurt the request path: fail fast, never queue.
          commandTimeout: 100,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 1000,
          retryStrategy: (times: number): number => Math.min(times * 200, 2000),
        });
        // Without a listener ioredis prints every reconnect failure; one warn per
        // error keeps a down Redis observable without drowning the log. A refused
        // connect on Node 18+ is an AggregateError whose own .message is EMPTY —
        // the detail lives in .errors (caught by the N3 verification run).
        const logger = new Logger('RedisClient');
        client.on('error', (error: Error) => {
          const nested = (error as { errors?: Error[] }).errors
            ?.map((inner) => inner.message)
            .join('; ');
          logger.warn(
            `redis ${redis.host}:${redis.port}: ${error.message || nested || error.constructor.name}`,
          );
        });
        return client;
      },
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
