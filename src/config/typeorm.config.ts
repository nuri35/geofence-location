import { ConfigType } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { databaseConfig } from './database.config';

export const typeOrmModuleFactory = (
  database: ConfigType<typeof databaseConfig>,
): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: database.host,
  port: database.port,
  username: database.username,
  password: database.password,
  database: database.database,
  autoLoadEntities: true,
  synchronize: false,
  migrationsRun: false,
});
