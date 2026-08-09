export enum ConfigNamespace {
  App = 'app',
  Areas = 'areas',
  Database = 'database',
}

export enum NodeEnvironment {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export enum EnvKey {
  NodeEnv = 'NODE_ENV',
  Port = 'PORT',
  PostgresHost = 'POSTGRES_HOST',
  PostgresPort = 'POSTGRES_PORT',
  PostgresUser = 'POSTGRES_USER',
  PostgresPassword = 'POSTGRES_PASSWORD',
  PostgresDb = 'POSTGRES_DB',
  PostgresPoolSize = 'POSTGRES_POOL_SIZE',
  PostgresAcquireTimeoutMs = 'POSTGRES_ACQUIRE_TIMEOUT_MS',
  PostgresStatementTimeoutMs = 'POSTGRES_STATEMENT_TIMEOUT_MS',
  PostgresIdleTxnTimeoutMs = 'POSTGRES_IDLE_TXN_TIMEOUT_MS',
  AreasPollIntervalMs = 'AREAS_POLL_INTERVAL_MS',
}

/**
 * Connection/query bounds (ADR 0009). Defaults live here so the Joi schema and the
 * database config namespace cannot drift apart. Ordering is enforced at boot:
 * acquire < statement < idle-in-transaction.
 */
export const DEFAULT_POOL_SIZE = 10;

/**
 * How often each instance polls area_version to catch polygon changes made by
 * other instances (ADR 0011's 30 s figure, adopted by ADR 0012). The creating
 * instance refreshes synchronously on POST /areas, so this bounds only
 * cross-instance staleness.
 */
export const DEFAULT_AREAS_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 2_000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;
export const DEFAULT_IDLE_TXN_TIMEOUT_MS = 10_000;
