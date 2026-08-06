import { registerAs } from '@nestjs/config';

import { ConfigNamespace, NodeEnvironment } from './config.constants';

export interface AppConfig {
  environment: NodeEnvironment;
  port: number;
}

export const appConfig = registerAs(ConfigNamespace.App, (): AppConfig => ({
  environment: (process.env.NODE_ENV as NodeEnvironment) ?? NodeEnvironment.Development,
  port: parseInt(process.env.PORT ?? '3000', 10),
}));
