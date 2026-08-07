import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePresenceTable1786110075607 implements MigrationInterface {
  name = 'CreatePresenceTable1786110075607';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The composite primary key is load-bearing (ADR 0002): it is the conflict target that
    // makes INSERT ... ON CONFLICT DO NOTHING the concurrency arbiter in the transition path.
    await queryRunner.query(`
      CREATE TABLE "user_area_presence" (
        "user_id" character varying(64) NOT NULL,
        "area_id" uuid NOT NULL,
        "entered_at" timestamptz NOT NULL DEFAULT now(),
        "last_seen_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_user_area_presence" PRIMARY KEY ("user_id", "area_id"),
        CONSTRAINT "fk_presence_area" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE CASCADE
      )
    `);
    // No area_id index: the cascade's lookup scans a table bounded by current memberships
    // (users x areas-currently-inside), which stays small — unlike the unbounded logs table.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "user_area_presence"');
  }
}
