import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { AreaEntity } from '@app/areas/entities/area.entity';

export const LOGS_TABLE = 'logs';

@Entity(LOGS_TABLE)
@Index('idx_logs_user_recorded', ['userId', 'recordedAt'])
@Index('idx_logs_area_recorded', ['areaId', 'recordedAt'])
export class LogEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64, name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'area_id' })
  areaId!: string;

  @ManyToOne(() => AreaEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'area_id' })
  area?: AreaEntity;

  /** Authoritative time — server receipt (decision 8). */
  @CreateDateColumn({ type: 'timestamptz', name: 'recorded_at' })
  recordedAt!: Date;

  /** Client's claim; informational only, used by no logic anywhere (ADR 0005). */
  @Column({ type: 'timestamptz', name: 'observed_at', nullable: true })
  observedAt!: Date | null;
}
