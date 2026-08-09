import { registerAs } from '@nestjs/config';

import { ConfigNamespace, EnvKey } from './config.constants';
import { requireEnv } from './env.util';

export interface MqConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

export const mqConfig = registerAs(ConfigNamespace.Mq, (): MqConfig => ({
  host: requireEnv(EnvKey.RabbitMqHost),
  port: parseInt(requireEnv(EnvKey.RabbitMqPort), 10),
  user: requireEnv(EnvKey.RabbitMqUser),
  password: requireEnv(EnvKey.RabbitMqPassword),
}));
