import { EnvKey } from './config.constants';

export const requireEnv = (key: EnvKey): string => {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};
