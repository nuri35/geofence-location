export enum ConfigNamespace {
  App = 'app',
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
}

/**
 * Connection/query bounds (ADR 0009). Defaults live here so the Joi schema and the
 * database config namespace cannot drift apart. Ordering is enforced at boot:
 * acquire < statement < idle-in-transaction.
 */
export const DEFAULT_POOL_SIZE = 10;
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 2_000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;
export const DEFAULT_IDLE_TXN_TIMEOUT_MS = 10_000;
