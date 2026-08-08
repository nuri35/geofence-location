import * as Joi from 'joi';

import {
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_IDLE_TXN_TIMEOUT_MS,
  DEFAULT_POOL_SIZE,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  EnvKey,
  NodeEnvironment,
} from './config.constants';

export const envValidationSchema = Joi.object({
  [EnvKey.NodeEnv]: Joi.string()
    .valid(...Object.values(NodeEnvironment))
    .default(NodeEnvironment.Development),
  [EnvKey.Port]: Joi.number().port().default(3000),
  [EnvKey.PostgresHost]: Joi.string().required(),
  [EnvKey.PostgresPort]: Joi.number().port().required(),
  [EnvKey.PostgresUser]: Joi.string().required(),
  [EnvKey.PostgresPassword]: Joi.string().required(),
  [EnvKey.PostgresDb]: Joi.string().required(),
  [EnvKey.PostgresPoolSize]: Joi.number().integer().min(1).max(100).default(DEFAULT_POOL_SIZE),
  [EnvKey.PostgresAcquireTimeoutMs]: Joi.number()
    .integer()
    .min(100)
    .default(DEFAULT_ACQUIRE_TIMEOUT_MS),
  [EnvKey.PostgresStatementTimeoutMs]: Joi.number()
    .integer()
    .min(100)
    .default(DEFAULT_STATEMENT_TIMEOUT_MS),
  [EnvKey.PostgresIdleTxnTimeoutMs]: Joi.number()
    .integer()
    .min(100)
    .default(DEFAULT_IDLE_TXN_TIMEOUT_MS),
}).custom((env: Record<string, unknown>) => {
  // ADR 0009: acquire < statement < idle-in-transaction. Waiting longer for a
  // connection than the bound on what holds connections just grows the queue, and a
  // session inside a legitimate long statement must never be culled as "idle". The
  // bad orderings are unrepresentable, not merely discouraged.
  const acquire = env[EnvKey.PostgresAcquireTimeoutMs] as number;
  const statement = env[EnvKey.PostgresStatementTimeoutMs] as number;
  const idleTxn = env[EnvKey.PostgresIdleTxnTimeoutMs] as number;
  if (acquire >= statement) {
    throw new Error(
      `${EnvKey.PostgresAcquireTimeoutMs} (${acquire}) must be < ${EnvKey.PostgresStatementTimeoutMs} (${statement}) — ADR 0009`,
    );
  }
  if (statement >= idleTxn) {
    throw new Error(
      `${EnvKey.PostgresStatementTimeoutMs} (${statement}) must be < ${EnvKey.PostgresIdleTxnTimeoutMs} (${idleTxn}) — ADR 0009`,
    );
  }
  return env;
}, 'timeout ordering (ADR 0009)');
