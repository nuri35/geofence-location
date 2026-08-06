import { registerAs } from '@nestjs/config';

import { ConfigNamespace, EnvKey } from './config.constants';
import { requireEnv } from './env.util';

export interface RedisConfig {
  host: string;
  port: number;
  password: string;
}

export const redisConfig = registerAs(ConfigNamespace.Redis, (): RedisConfig => ({
  host: requireEnv(EnvKey.RedisHost),
  port: parseInt(requireEnv(EnvKey.RedisPort), 10),
  password: process.env[EnvKey.RedisPassword] ?? '',
}));
