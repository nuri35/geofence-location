import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLogsTable1786110074569 implements MigrationInterface {
  name = 'CreateLogsTable1786110074569';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" character varying(64) NOT NULL,
        "area_id" uuid NOT NULL,
        "recorded_at" timestamptz NOT NULL DEFAULT now(),
        "observed_at" timestamptz,
        CONSTRAINT "pk_logs_id" PRIMARY KEY ("id"),
        CONSTRAINT "fk_logs_area" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "idx_logs_user_recorded" ON "logs" ("user_id", "recorded_at" DESC)',
    );
    // area_id-leading index: serves the ADR 0006 areaId filter AND the FK cascade —
    // without it, every area delete seq-scans this unbounded table to find its log rows.
    await queryRunner.query(
      'CREATE INDEX "idx_logs_area_recorded" ON "logs" ("area_id", "recorded_at" DESC)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "idx_logs_area_recorded"');
    await queryRunner.query('DROP INDEX "idx_logs_user_recorded"');
    await queryRunner.query('DROP TABLE "logs"');
  }
}
