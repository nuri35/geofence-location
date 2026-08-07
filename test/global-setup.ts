import 'reflect-metadata';
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
// unreliably). A new migration must be added here — the e2e suite failing on a
// missing table is the reminder.
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
};

export default provisionE2eDatabase;
