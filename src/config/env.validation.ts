import * as Joi from 'joi';

import { EnvKey, NodeEnvironment } from './config.constants';

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
  [EnvKey.RedisHost]: Joi.string().required(),
  [EnvKey.RedisPort]: Joi.number().port().required(),
  [EnvKey.RedisPassword]: Joi.string().allow('').default(''),
});
