import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUserEventState1786247465996 implements MigrationInterface {
  name = 'CreateUserEventState1786247465996';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Per-device dedup state (ADR 0010). Keyed (user_id, device_id) because one user's
    // devices carry independent seq counters. seq is for DEDUP ONLY — it is not an
    // ordering guarantee (retries, multi-device, network reordering all break that).
    await queryRunner.query(`
      CREATE TABLE "user_event_state" (
        "user_id" character varying(64) NOT NULL,
        "device_id" character varying(64) NOT NULL,
        "last_seq" bigint NOT NULL,
        "last_event_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_user_event_state" PRIMARY KEY ("user_id", "device_id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "user_event_state"');
  }
}
