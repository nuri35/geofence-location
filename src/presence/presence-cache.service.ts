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

  /**
   * TTL differs by VALUE (ADR 0013 addendum): a stale non-empty set can suppress a
   * re-entry (the fatal direction) so it lives on the short clock; a stale "[]" can
   * only suppress an exit deletion — a merged visit, already tolerated by non-goal —
   * and heals on the next inside ping, so it may live long.
   */
  async populate(userId: string, areaIds: string[]): Promise<void> {
    const ttlS =
      areaIds.length === 0 ? this.config.presenceTtlEmptyS : this.config.presenceTtlNonEmptyS;
    try {
      await this.redis.set(this.key(userId), JSON.stringify(areaIds), 'EX', ttlS);
    } catch {
      this.logger.debug(`cache populate skipped for ${userId}: redis unavailable`);
    }
  }

  /**
   * Idempotent; called after every change-path commit. Returns whether the DEL
   * actually happened: a failure opens a staleness window bounded by the non-empty
   * TTL, and the caller counts it QUALIFIED by whether GETs were succeeding — a
   * failed DEL during a full outage is the safe case (reads fall through too); a
   * failed DEL while GETs succeed is the flap that can suppress entries.
   */
  async invalidate(userId: string): Promise<boolean> {
    try {
      await this.redis.del(this.key(userId));
      return true;
    } catch {
      this.logger.warn(
        `cache invalidate FAILED for ${userId}: stale window opens, bounded by ttl=${this.config.presenceTtlNonEmptyS}s`,
      );
      return false;
    }
  }

  private key(userId: string): string {
    return `presence:${userId}`;
  }
}
