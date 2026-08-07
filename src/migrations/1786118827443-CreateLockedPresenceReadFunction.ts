import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLockedPresenceReadFunction1786118827443 implements MigrationInterface {
  name = 'CreateLockedPresenceReadFunction1786118827443';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Path A of ADR 0007: fold the advisory lock and the presence read into ONE round trip.
    // A plpgsql body is the only fold whose ordering is DOCUMENTED semantics: statements in
    // a function body execute sequentially, so the lock is provably acquired before the
    // read. A same-statement fold (InitPlan) blocked correctly in both plan shapes when
    // tested, but that ordering is an unguaranteed planner property — not good enough for
    // the statement that carries the concurrency guarantee.
    await queryRunner.query(`
      CREATE FUNCTION lock_user_and_read_presence(uid character varying)
      RETURNS TABLE (area_id uuid)
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext(uid));
        RETURN QUERY SELECT p."area_id" FROM "user_area_presence" p WHERE p."user_id" = uid;
      END;
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP FUNCTION lock_user_and_read_presence(character varying)');
  }
}
