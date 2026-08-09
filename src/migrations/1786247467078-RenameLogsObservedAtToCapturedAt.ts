import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameLogsObservedAtToCapturedAt1786247467078 implements MigrationInterface {
  name = 'RenameLogsObservedAtToCapturedAt1786247467078';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ADR 0010: capturedAt replaces observedAt — same semantic (device-side reading
    // time, informational only, feeds no logic), new name from the adaptive payload
    // contract. Metadata-only rename; existing row values carry over unchanged.
    await queryRunner.query('ALTER TABLE "logs" RENAME COLUMN "observed_at" TO "captured_at"');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "logs" RENAME COLUMN "captured_at" TO "observed_at"');
  }
}
