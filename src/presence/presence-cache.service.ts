import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';

import { redisConfig } from '@config/redis.config';

import { REDIS_CLIENT } from '@app/redis/redis.constants';

/**
 * 'miss' and 'error' both fall through to the database, but ONLY a miss may write
 * back: after an error we do not know whether a value exists, and writing one could
 * resurrect state a concurrent invalidation just removed.
 */
export type PresenceCacheRead =
  { status: 'hit'; areaIds: string[] } | { status: 'miss' } | { status: 'error' };

/**
 * ADR 0013: the cache answers "do I need to write?", never "what do I write?" —
 * values read here may ONLY gate the no-change fast path; every write recomputes
 * against the locked authoritative read. Restored from the ADR 0007-era service
 * with one addition: every populate carries a TTL, the upper bound on how long a
 * stale key can suppress the fast path after a failed DEL or a read-aside race.
 */
@Injectable()
export class PresenceCacheService {
  private readonly logger = new Logger(PresenceCacheService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(redisConfig.KEY) private readonly config: ConfigType<typeof redisConfig>,
  ) {}

  /**
   * Value is a JSON string array; "[]" is a real value distinguishing "known to be in
   * no areas" from "not cached" (a Redis SET cannot represent an empty set).
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
      await this.redis.set(
        this.key(userId),
        JSON.stringify(areaIds),
        'EX',
        this.config.presenceTtlS,
      );
    } catch {
      this.logger.debug(`cache populate skipped for ${userId}: redis unavailable`);
    }
  }

  /**
   * Idempotent; called after every change-path commit. A failed DEL is the start of
   * a staleness window bounded by the TTL — warn, because entries inside that window
   * on this key's user are suppressed (ADR 0013 records the exposure).
   */
  async invalidate(userId: string): Promise<void> {
    try {
      await this.redis.del(this.key(userId));
    } catch {
      this.logger.warn(
        `cache invalidate FAILED for ${userId}: stale window opens, bounded by ttl=${this.config.presenceTtlS}s`,
      );
    }
  }

  private key(userId: string): string {
    return `presence:${userId}`;
  }
}
