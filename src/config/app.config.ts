import { registerAs } from '@nestjs/config';

import { ConfigNamespace, EnvKey, NodeEnvironment } from './config.constants';

export interface AppConfig {
  environment: NodeEnvironment;
  port: number;
}

export const appConfig = registerAs(ConfigNamespace.App, (): AppConfig => ({
  environment: (process.env[EnvKey.NodeEnv] as NodeEnvironment) ?? NodeEnvironment.Development,
  port: parseInt(process.env[EnvKey.Port] ?? '3000', 10),
}));
