import { registerAs } from '@nestjs/config';

import {
  ConfigNamespace,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_IDLE_TXN_TIMEOUT_MS,
  DEFAULT_POOL_SIZE,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  EnvKey,
} from './config.constants';
import { requireEnv } from './env.util';

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  /** Deliberate, not TypeORM's default (ADR 0009): N x poolSize must stay under max_connections. */
  poolSize: number;
  /** Bounds waiting for a pooled connection — the proven silent-hang otherwise (ADR 0009). */
  acquireTimeoutMs: number;
  /** Server-side statement ceiling; bounds the advisory-lock convoy (ADR 0009). */
  statementTimeoutMs: number;
  /** Server-side kill for transactions left idle by a hung Node side (ADR 0009). */
  idleTxnTimeoutMs: number;
}

const intFromEnv = (key: EnvKey, fallback: number): number =>
  parseInt(process.env[key] ?? String(fallback), 10);

export const databaseConfig = registerAs(ConfigNamespace.Database, (): DatabaseConfig => ({
  host: requireEnv(EnvKey.PostgresHost),
  port: parseInt(requireEnv(EnvKey.PostgresPort), 10),
  username: requireEnv(EnvKey.PostgresUser),
  password: requireEnv(EnvKey.PostgresPassword),
  database: requireEnv(EnvKey.PostgresDb),
  poolSize: intFromEnv(EnvKey.PostgresPoolSize, DEFAULT_POOL_SIZE),
  acquireTimeoutMs: intFromEnv(EnvKey.PostgresAcquireTimeoutMs, DEFAULT_ACQUIRE_TIMEOUT_MS),
  statementTimeoutMs: intFromEnv(EnvKey.PostgresStatementTimeoutMs, DEFAULT_STATEMENT_TIMEOUT_MS),
  idleTxnTimeoutMs: intFromEnv(EnvKey.PostgresIdleTxnTimeoutMs, DEFAULT_IDLE_TXN_TIMEOUT_MS),
}));
