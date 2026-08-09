export enum ConfigNamespace {
  App = 'app',
  Areas = 'areas',
  Database = 'database',
  Mq = 'mq',
  Redis = 'redis',
  Worker = 'worker',
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
  PresenceCacheTtlEmptyS = 'PRESENCE_CACHE_TTL_EMPTY_S',
  PresenceCacheTtlNonEmptyS = 'PRESENCE_CACHE_TTL_NONEMPTY_S',
  RabbitMqHost = 'RABBITMQ_HOST',
  RabbitMqPort = 'RABBITMQ_PORT',
  RabbitMqUser = 'RABBITMQ_USER',
  RabbitMqPassword = 'RABBITMQ_PASSWORD',
  WorkerPartitions = 'WORKER_PARTITIONS',
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
 * Presence-cache staleness bounds, differentiated by value (ADR 0013 addendum).
 * The danger is asymmetric: a stale NON-EMPTY set is the entry-killer (it can
 * suppress a re-entry into the same area), so it gets the short clock; a stale
 * "[]" heals on the next inside ping and can only suppress an exit deletion —
 * a merged visit, which this system already tolerates by declared non-goal.
 * Worst-case entry suppression equals the NON-EMPTY value.
 */
export const DEFAULT_PRESENCE_CACHE_TTL_EMPTY_S = 300;
export const DEFAULT_PRESENCE_CACHE_TTL_NONEMPTY_S = 15;
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 2_000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;
export const DEFAULT_IDLE_TXN_TIMEOUT_MS = 10_000;
