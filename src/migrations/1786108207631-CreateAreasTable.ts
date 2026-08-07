import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAreasTable1786108207631 implements MigrationInterface {
  name = 'CreateAreasTable1786108207631';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "areas" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(255) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "boundary" geometry(Polygon,4326) NOT NULL,
        CONSTRAINT "pk_areas_id" PRIMARY KEY ("id"),
        CONSTRAINT "chk_areas_boundary_valid" CHECK (ST_IsValid("boundary"))
      )
    `);
    await queryRunner.query('CREATE INDEX "idx_areas_boundary" ON "areas" USING GiST ("boundary")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "idx_areas_boundary"');
    await queryRunner.query('DROP TABLE "areas"');
  }
}
