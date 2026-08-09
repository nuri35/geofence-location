import { registerAs } from '@nestjs/config';

import { ConfigNamespace, DEFAULT_AREAS_POLL_INTERVAL_MS, EnvKey } from './config.constants';

export interface AreasConfig {
  pollIntervalMs: number;
}

export const areasConfig = registerAs(ConfigNamespace.Areas, (): AreasConfig => ({
  pollIntervalMs: parseInt(
    process.env[EnvKey.AreasPollIntervalMs] ?? String(DEFAULT_AREAS_POLL_INTERVAL_MS),
    10,
  ),
}));
