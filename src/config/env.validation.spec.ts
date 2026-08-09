import { EnvKey } from './config.constants';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  [EnvKey.PostgresHost]: 'localhost',
  [EnvKey.PostgresPort]: 5433,
  [EnvKey.PostgresUser]: 'geofence',
  [EnvKey.PostgresPassword]: 'geofence',
  [EnvKey.PostgresDb]: 'geofence',
  [EnvKey.RedisHost]: 'localhost',
  [EnvKey.RedisPort]: 6379,
  [EnvKey.RabbitMqHost]: 'localhost',
  [EnvKey.RabbitMqPort]: 5672,
  [EnvKey.RabbitMqUser]: 'geofence',
  [EnvKey.RabbitMqPassword]: 'geofence',
};

describe('envValidationSchema — Redis vars (ADR 0013)', () => {
  it('requires REDIS_HOST and REDIS_PORT — infra coordinates are never guessed', () => {
    const withoutHost: Record<string, unknown> = { ...requiredEnv };
    delete withoutHost[EnvKey.RedisHost];
    expect(envValidationSchema.validate(withoutHost).error?.message).toContain('REDIS_HOST');
  });

  it('defaults the differentiated presence-cache TTLs and accepts explicit overrides', () => {
    const defaulted = envValidationSchema.validate(requiredEnv);
    const value = defaulted.value as Record<string, number>;
    // Short clock on the entry-killing direction, long on the safe one (ADR 0013 addendum).
    expect(value[EnvKey.PresenceCacheTtlNonEmptyS]).toBe(15);
    expect(value[EnvKey.PresenceCacheTtlEmptyS]).toBe(300);
    const explicit = envValidationSchema.validate({
      ...requiredEnv,
      [EnvKey.PresenceCacheTtlNonEmptyS]: 2,
      [EnvKey.PresenceCacheTtlEmptyS]: 60,
    });
    expect(explicit.error).toBeUndefined();
  });
});

describe('envValidationSchema — ADR 0009 timeout ordering', () => {
  it('accepts the defaults (acquire 2s < statement 5s < idle-txn 10s)', () => {
    const result = envValidationSchema.validate(requiredEnv);
    const value = result.value as Record<string, number>;
    expect(result.error).toBeUndefined();
    expect(value[EnvKey.PostgresPoolSize]).toBe(10);
    expect(value[EnvKey.PostgresAcquireTimeoutMs]).toBe(2000);
    expect(value[EnvKey.PostgresStatementTimeoutMs]).toBe(5000);
    expect(value[EnvKey.PostgresIdleTxnTimeoutMs]).toBe(10000);
  });

  it('rejects acquire >= statement', () => {
    const result = envValidationSchema.validate({
      ...requiredEnv,
      [EnvKey.PostgresAcquireTimeoutMs]: 6000,
    });
    expect(result.error?.message).toContain('POSTGRES_ACQUIRE_TIMEOUT_MS');
  });

  it('rejects statement >= idle-in-transaction', () => {
    const result = envValidationSchema.validate({
      ...requiredEnv,
      [EnvKey.PostgresStatementTimeoutMs]: 10000,
    });
    expect(result.error?.message).toContain('POSTGRES_STATEMENT_TIMEOUT_MS');
  });

  it('accepts a valid explicit ordering', () => {
    const result = envValidationSchema.validate({
      ...requiredEnv,
      [EnvKey.PostgresAcquireTimeoutMs]: 1000,
      [EnvKey.PostgresStatementTimeoutMs]: 3000,
      [EnvKey.PostgresIdleTxnTimeoutMs]: 8000,
    });
    expect(result.error).toBeUndefined();
  });
});
