import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase N2 (ADR 0012): singleton counter the in-memory polygon snapshot polls.
 * POST /areas bumps it in the same transaction as the area insert; each app
 * instance rebuilds its index when the value it last saw moves.
 */
export class CreateAreaVersion1786250194892 implements MigrationInterface {
  name = 'CreateAreaVersion1786250194892';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Singleton row: the CHECK makes a second row unrepresentable. bigint never wraps.
    await queryRunner.query(`
      CREATE TABLE "area_version" (
        "id" smallint NOT NULL DEFAULT 1,
        "version" bigint NOT NULL DEFAULT 1,
        CONSTRAINT "pk_area_version" PRIMARY KEY ("id"),
        CONSTRAINT "chk_area_version_singleton" CHECK ("id" = 1)
      )
    `);
    await queryRunner.query(`INSERT INTO "area_version" ("id", "version") VALUES (1, 1)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "area_version"');
  }
}
