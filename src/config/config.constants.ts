export enum ConfigNamespace {
  App = 'app',
  Database = 'database',
  Redis = 'redis',
}

export enum NodeEnvironment {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/** ADR 0007: presence read strategy candidates, decision pending measurement. */
export enum PresenceReadStrategy {
  /** Baseline: separate lock statement, then presence SELECT (Phase 2 behaviour). */
  TwoStep = 'two-step',
  /** Path A: one round trip via the lock_user_and_read_presence() function. */
  Folded = 'folded',
  /** Path B: Redis read-through cache in front of the presence read. */
  Cache = 'cache',
}

export enum EnvKey {
  NodeEnv = 'NODE_ENV',
  Port = 'PORT',
  PresenceReadStrategy = 'PRESENCE_READ_STRATEGY',
  PostgresHost = 'POSTGRES_HOST',
  PostgresPort = 'POSTGRES_PORT',
  PostgresUser = 'POSTGRES_USER',
  PostgresPassword = 'POSTGRES_PASSWORD',
  PostgresDb = 'POSTGRES_DB',
  RedisHost = 'REDIS_HOST',
  RedisPort = 'REDIS_PORT',
  RedisPassword = 'REDIS_PASSWORD',
}
