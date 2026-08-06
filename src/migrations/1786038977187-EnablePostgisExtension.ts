import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnablePostgisExtension1786038977187 implements MigrationInterface {
  name = 'EnablePostgisExtension1786038977187';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS postgis;');
  }

  public down(): Promise<void> {
    // Deliberate no-op: DROP EXTENSION ... CASCADE would destroy every spatial column in the
    // database, and the extension may predate this migration (the postgis image installs it at initdb).
    return Promise.resolve();
  }
}
