import { Injectable } from '@nestjs/common';

/**
 * Worker-local presence memory (N5B, ADR 0018). Provided ONLY by WorkerModule:
 * with static partition ownership the same user always lands on the same worker,
 * so this process can simply remember — presence reads become Map lookups, and
 * the ADR 0013 stale-cache hazard leaves the hot path structurally (the writer
 * and the reader are the same process; there is no invalidation to lose).
 *
 * CONTRACT (the ADR 0017 rule, enforced by shape):
 * - This API is SYNCHRONOUS ONLY — no method contains an await, so no interleave
 *   can occur inside it. The remaining requirement sits on callers: same-user
 *   calls must be serialized, which in this codebase is the worker's per-user
 *   chain (WorkerConsumerService.enqueue). Do not call from a context that does
 *   not serialize per user — the API process deliberately does NOT provide this
 *   service (multi-instance API memory would be split-brain, ADR 0011).
 * - Values are seeded from Postgres only (never Redis): a cold read after
 *   restart must not copy a possibly-stale key into a Map with no TTL.
 */
@Injectable()
export class PresenceMemoryService {
  private readonly areaIdsByUser = new Map<string, string[]>();

  get(userId: string): string[] | undefined {
    return this.areaIdsByUser.get(userId);
  }

  set(userId: string, areaIds: string[]): void {
    this.areaIdsByUser.set(userId, areaIds);
  }

  /** Observable for tests, memory reporting, and N5-final's rebalance handoff. */
  get size(): number {
    return this.areaIdsByUser.size;
  }
}
