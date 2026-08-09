export enum ConfigNamespace {
  App = 'app',
  Areas = 'areas',
  Database = 'database',
  Redis = 'redis',
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
  RedisHost = 'REDIS_HOST',
  RedisPort = 'REDIS_PORT',
  RedisPassword = 'REDIS_PASSWORD',
  PresenceCacheTtlS = 'PRESENCE_CACHE_TTL_S',
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

/**
 * Upper bound on presence-cache staleness (ADR 0013). Invalidate-after-commit is
 * the primary mechanism; the TTL is the backstop that bounds the two ways a key
 * can stay stale (a failed post-commit DEL, and the read-aside race where a miss
 * populate lands after a concurrent commit's DEL). Worst-case entry suppression
 * equals this value.
 */
export const DEFAULT_PRESENCE_CACHE_TTL_S = 300;
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 2_000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;
export const DEFAULT_IDLE_TXN_TIMEOUT_MS = 10_000;
