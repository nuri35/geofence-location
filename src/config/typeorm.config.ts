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
  poolSize: database.poolSize,
  extra: {
    // ADR 0009 — the three bounds, applied where they actually take effect on pooled
    // connections: connectionTimeoutMillis is pg-pool's acquire timeout (also covers
    // waiting for a free pooled client, proven by probe); statement_timeout and
    // idle_in_transaction_session_timeout are sent by node-postgres as per-connection
    // server settings on every pooled client. The migration CLI data source
    // deliberately does NOT carry these (src/config/data-source.ts).
    connectionTimeoutMillis: database.acquireTimeoutMs,
    statement_timeout: database.statementTimeoutMs,
    idle_in_transaction_session_timeout: database.idleTxnTimeoutMs,
  },
});
