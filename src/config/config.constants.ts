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
}
