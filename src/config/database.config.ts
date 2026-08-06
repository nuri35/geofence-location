import { registerAs } from '@nestjs/config';

import { ConfigNamespace, EnvKey } from './config.constants';
import { requireEnv } from './env.util';

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export const databaseConfig = registerAs(ConfigNamespace.Database, (): DatabaseConfig => ({
  host: requireEnv(EnvKey.PostgresHost),
  port: parseInt(requireEnv(EnvKey.PostgresPort), 10),
  username: requireEnv(EnvKey.PostgresUser),
  password: requireEnv(EnvKey.PostgresPassword),
  database: requireEnv(EnvKey.PostgresDb),
}));
