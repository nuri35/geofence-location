import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

// Relative imports on purpose: jest moduleNameMapper does not apply to globalSetup.
import { EnvKey } from '../src/config/config.constants';
import { requireEnv } from '../src/config/env.util';
import { EnablePostgisExtension1786038977187 } from '../src/migrations/1786038977187-EnablePostgisExtension';
import { CreateAreasTable1786108207631 } from '../src/migrations/1786108207631-CreateAreasTable';
import { CreateLogsTable1786110074569 } from '../src/migrations/1786110074569-CreateLogsTable';
import { CreatePresenceTable1786110075607 } from '../src/migrations/1786110075607-CreatePresenceTable';
import { CreateLockedPresenceReadFunction1786118827443 } from '../src/migrations/1786118827443-CreateLockedPresenceReadFunction';
import { CreateLogsRecordedIdIndex1786128051611 } from '../src/migrations/1786128051611-CreateLogsRecordedIdIndex';
import { E2E_DATABASE_NAME } from './e2e-constants';

// Migrations are imported explicitly (no glob: transform contexts resolve globs
// unreliably). A new migration must be added here BY HAND — and forgetting fails in
// two very different ways (established by the migration audit, 2026-08-07): a missing
// TABLE or FUNCTION fails the suite loudly, but a missing INDEX or CONSTRAINT passes
// silently with a test schema that differs from production. The count guard below
// exists to turn that silent case loud.
const MIGRATIONS = [
  EnablePostgisExtension1786038977187,
  CreateAreasTable1786108207631,
  CreateLogsTable1786110074569,
  CreatePresenceTable1786110075607,
  CreateLockedPresenceReadFunction1786118827443,
  CreateLogsRecordedIdIndex1786128051611,
];

const provisionE2eDatabase = async (): Promise<void> => {
  config();

  const admin = new Client({
    host: requireEnv(EnvKey.PostgresHost),
    port: parseInt(requireEnv(EnvKey.PostgresPort), 10),
    user: requireEnv(EnvKey.PostgresUser),
    password: requireEnv(EnvKey.PostgresPassword),
    database: requireEnv(EnvKey.PostgresDb),
  });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${E2E_DATABASE_NAME}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${E2E_DATABASE_NAME}"`);
  } finally {
    await admin.end();
  }

  const dataSource = new DataSource({
    type: 'postgres',
    host: requireEnv(EnvKey.PostgresHost),
    port: parseInt(requireEnv(EnvKey.PostgresPort), 10),
    username: requireEnv(EnvKey.PostgresUser),
    password: requireEnv(EnvKey.PostgresPassword),
    database: E2E_DATABASE_NAME,
    migrations: MIGRATIONS,
    migrationsTableName: 'migrations',
  });
  await dataSource.initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }

  // Plain fs, not a glob — globs not resolving in this transform context is exactly
  // why the MIGRATIONS list above is manual in the first place.
  const migrationsOnDisk = readdirSync(join(__dirname, '..', 'src', 'migrations')).filter((file) =>
    file.endsWith('.ts'),
  );
  if (migrationsOnDisk.length !== MIGRATIONS.length) {
    throw new Error(
      `e2e migration list is out of sync: test/global-setup.ts lists ${MIGRATIONS.length} ` +
        `migration(s) but src/migrations/ contains ${migrationsOnDisk.length} file(s). ` +
        `Import the missing migration(s) and add them to the MIGRATIONS array in ` +
        `test/global-setup.ts. Without this guard, a missing index or constraint migration ` +
        `passes the suite silently against a schema that differs from production.`,
    );
  }
};

export default provisionE2eDatabase;
