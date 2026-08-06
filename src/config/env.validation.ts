import * as Joi from 'joi';

import { NodeEnvironment } from './config.constants';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid(...Object.values(NodeEnvironment))
    .default(NodeEnvironment.Development),
  PORT: Joi.number().port().default(3000),
  POSTGRES_HOST: Joi.string().default('localhost'),
  POSTGRES_PORT: Joi.number().port().default(5432),
  POSTGRES_USER: Joi.string().default('geofence'),
  POSTGRES_PASSWORD: Joi.string().default('geofence'),
  POSTGRES_DB: Joi.string().default('geofence'),
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
});
