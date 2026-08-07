import { registerAs } from '@nestjs/config';

import { ConfigNamespace, EnvKey, NodeEnvironment, PresenceReadStrategy } from './config.constants';

export interface AppConfig {
  environment: NodeEnvironment;
  port: number;
  /** ADR 0007, decided by measurement: folded default; alternates kept for reversibility. */
  presenceReadStrategy: PresenceReadStrategy;
}

export const appConfig = registerAs(ConfigNamespace.App, (): AppConfig => ({
  environment: (process.env[EnvKey.NodeEnv] as NodeEnvironment) ?? NodeEnvironment.Development,
  port: parseInt(process.env[EnvKey.Port] ?? '3000', 10),
  presenceReadStrategy:
    (process.env[EnvKey.PresenceReadStrategy] as PresenceReadStrategy) ??
    PresenceReadStrategy.Folded,
}));
