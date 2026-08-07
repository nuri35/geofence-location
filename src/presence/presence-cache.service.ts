import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { REDIS_CLIENT } from '@app/redis/redis.constants';

/**
 * 'miss' and 'error' both fall through to the database, but ONLY a miss may write
 * back: after an error we do not know whether a value exists, and writing one could
 * resurrect state a concurrent invalidation just removed.
 */
export type PresenceCacheRead =
  { status: 'hit'; areaIds: string[] } | { status: 'miss' } | { status: 'error' };

@Injectable()
export class PresenceCacheService {
  private readonly logger = new Logger(PresenceCacheService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Value is a JSON string array; "[]" is a real value distinguishing "known to be in
   * no areas" from "not cached" (decision 6 — a Redis SET cannot represent an empty set).
   */
  async get(userId: string): Promise<PresenceCacheRead> {
    try {
      const raw = await this.redis.get(this.key(userId));
      if (raw === null) {
        return { status: 'miss' };
      }
      return { status: 'hit', areaIds: JSON.parse(raw) as string[] };
    } catch {
      return { status: 'error' };
    }
  }

  async populate(userId: string, areaIds: string[]): Promise<void> {
    try {
      await this.redis.set(this.key(userId), JSON.stringify(areaIds));
    } catch {
      this.logger.debug(`cache populate skipped for ${userId}: redis unavailable`);
    }
  }

  /** Idempotent and safe to lose — a deleted or never-deleted-because-down key both just cause a DB read. */
  async invalidate(userId: string): Promise<void> {
    try {
      await this.redis.del(this.key(userId));
    } catch {
      this.logger.debug(`cache invalidate skipped for ${userId}: redis unavailable`);
    }
  }

  private key(userId: string): string {
    return `presence:${userId}`;
  }
}
