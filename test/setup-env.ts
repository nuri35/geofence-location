import { E2E_DATABASE_NAME } from './e2e-constants';

// Runs in the test process before any module loads: every AppModule the e2e suite
// boots connects to the dedicated e2e database, never the dev one.
process.env.POSTGRES_DB = E2E_DATABASE_NAME;
