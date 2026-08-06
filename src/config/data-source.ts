import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';

import { EnvKey } from './config.constants';
import { requireEnv } from './env.util';

config();

export default new DataSource({
  type: 'postgres',
  host: requireEnv(EnvKey.PostgresHost),
  port: parseInt(requireEnv(EnvKey.PostgresPort), 10),
  username: requireEnv(EnvKey.PostgresUser),
  password: requireEnv(EnvKey.PostgresPassword),
  database: requireEnv(EnvKey.PostgresDb),
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
  migrationsTableName: 'migrations',
});
