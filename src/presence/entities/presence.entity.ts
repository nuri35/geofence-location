import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { AreaEntity } from '@app/areas/entities/area.entity';

export const PRESENCE_TABLE = 'user_area_presence';

/**
 * Source of truth for current area membership (ADR 0002). The composite primary key
 * (two @PrimaryColumn decorators — TypeORM collects them into EntityMetadata.primaryColumns)
 * is load-bearing: it is the ON CONFLICT target that arbitrates concurrency in Phase 2B.
 * Never replace it with a surrogate id plus a unique constraint.
 */
@Entity(PRESENCE_TABLE)
export class PresenceEntity {
  @PrimaryColumn({ type: 'varchar', length: 64, name: 'user_id' })
  userId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'area_id' })
  areaId!: string;

  @ManyToOne(() => AreaEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'area_id' })
  area?: AreaEntity;

  @Column({ type: 'timestamptz', name: 'entered_at', default: () => 'now()' })
  enteredAt!: Date;

  /**
   * "When this membership last changed" — written only when the row is written during a
   * transition, never refreshed on a read-only request, never a decision input (decision 10).
   */
  @Column({ type: 'timestamptz', name: 'last_seen_at', default: () => 'now()' })
  lastSeenAt!: Date;
}
