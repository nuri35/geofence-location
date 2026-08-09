import { Column, Entity, PrimaryColumn } from 'typeorm';

export const USER_EVENT_STATE_TABLE = 'user_event_state';

/**
 * Per-device dedup state (ADR 0010). One user may run several devices with
 * independent seq counters, so the key is (user_id, device_id) — never user alone.
 * `seq` is for DEDUP ONLY, not ordering: retries, multi-device users and network
 * reordering all break monotonic arrival, and nothing here may assume otherwise.
 * Written only through the transaction's manager, like all hot-path state.
 */
@Entity(USER_EVENT_STATE_TABLE)
export class UserEventStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 64, name: 'user_id' })
  userId!: string;

  @PrimaryColumn({ type: 'varchar', length: 64, name: 'device_id' })
  deviceId!: string;

  @Column({ type: 'bigint', name: 'last_seq' })
  lastSeq!: string;

  @Column({ type: 'timestamptz', name: 'last_event_at', default: () => 'now()' })
  lastEventAt!: Date;
}
