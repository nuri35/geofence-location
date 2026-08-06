import { registerAs } from '@nestjs/config';

import { ConfigNamespace } from './config.constants';

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export const databaseConfig = registerAs(ConfigNamespace.Database, (): DatabaseConfig => ({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  username: process.env.POSTGRES_USER ?? 'geofence',
  password: process.env.POSTGRES_PASSWORD ?? 'geofence',
  database: process.env.POSTGRES_DB ?? 'geofence',
}));
