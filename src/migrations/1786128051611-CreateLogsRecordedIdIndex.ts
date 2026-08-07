import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLogsRecordedIdIndex1786128051611 implements MigrationInterface {
  name = 'CreateLogsRecordedIdIndex1786128051611';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // GET /logs keyset walk (ADR 0006). Justified by measurement, not reflex: at 200k
    // rows the unfiltered newest-first page was a 41 ms parallel seq scan + top-N sort
    // over the whole table; with this index it is a plain index scan. Also serves the
    // from/to time-range filter (was an 18 ms seq scan). The user_id/area_id-leading
    // indexes already cover the filtered walks (sub-millisecond, incremental sort).
    await queryRunner.query(
      'CREATE INDEX "idx_logs_recorded_id" ON "logs" ("recorded_at" DESC, "id" DESC)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "idx_logs_recorded_id"');
  }
}
