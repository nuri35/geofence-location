import { registerAs } from '@nestjs/config';

import { ConfigNamespace } from './config.constants';

export interface RedisConfig {
  host: string;
  port: number;
  password: string;
}

export const redisConfig = registerAs(ConfigNamespace.Redis, (): RedisConfig => ({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD ?? '',
}));
