import { registerAs } from '@nestjs/config';

import {
  ConfigNamespace,
  DEFAULT_PRESENCE_CACHE_TTL_EMPTY_S,
  DEFAULT_PRESENCE_CACHE_TTL_NONEMPTY_S,
  EnvKey,
} from './config.constants';
import { requireEnv } from './env.util';

export interface RedisConfig {
  host: string;
  port: number;
  password: string;
  /** Staleness bound for a cached "[]" — the safe direction (ADR 0013 addendum). */
  presenceTtlEmptyS: number;
  /** Staleness bound for a cached non-empty set — the entry-killing direction. */
  presenceTtlNonEmptyS: number;
}

export const redisConfig = registerAs(ConfigNamespace.Redis, (): RedisConfig => ({
  host: requireEnv(EnvKey.RedisHost),
  port: parseInt(requireEnv(EnvKey.RedisPort), 10),
  password: process.env[EnvKey.RedisPassword] ?? '',
  presenceTtlEmptyS: parseInt(
    process.env[EnvKey.PresenceCacheTtlEmptyS] ?? String(DEFAULT_PRESENCE_CACHE_TTL_EMPTY_S),
    10,
  ),
  presenceTtlNonEmptyS: parseInt(
    process.env[EnvKey.PresenceCacheTtlNonEmptyS] ?? String(DEFAULT_PRESENCE_CACHE_TTL_NONEMPTY_S),
    10,
  ),
}));
