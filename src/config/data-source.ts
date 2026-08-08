import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';

import { EnvKey } from './config.constants';
import { requireEnv } from './env.util';

config();

// Deliberately carries NONE of the ADR 0009 bounds (statement_timeout etc.): a
// migration legitimately runs longer than the request path's 5 s ceiling (index
// builds, backfills), it is operator-attended, and the failure chain those bounds
// close — a shared request pool held hostage — does not exist on this single
// unpooled CLI connection.
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
