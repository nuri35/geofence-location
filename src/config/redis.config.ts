import { registerAs } from '@nestjs/config';

import { ConfigNamespace, DEFAULT_PRESENCE_CACHE_TTL_S, EnvKey } from './config.constants';
import { requireEnv } from './env.util';

export interface RedisConfig {
  host: string;
  port: number;
  password: string;
  /** Presence-cache staleness bound in seconds (ADR 0013); the cache's single policy knob. */
  presenceTtlS: number;
}

export const redisConfig = registerAs(ConfigNamespace.Redis, (): RedisConfig => ({
  host: requireEnv(EnvKey.RedisHost),
  port: parseInt(requireEnv(EnvKey.RedisPort), 10),
  password: process.env[EnvKey.RedisPassword] ?? '',
  presenceTtlS: parseInt(
    process.env[EnvKey.PresenceCacheTtlS] ?? String(DEFAULT_PRESENCE_CACHE_TTL_S),
    10,
  ),
}));
