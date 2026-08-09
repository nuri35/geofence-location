/** Partition queue name prefix — the N4A topology's loc.events.p{i}. */
export const PARTITION_QUEUE_PREFIX = 'loc.events.p';

/**
 * TEMPORARY BY DECISION (ADR 0016): prefetch 1 per consumer keeps one in-flight
 * message per partition, which is what preserves per-user ordering. Raising it
 * requires the per-user parallelism machinery scheduled for N5.
 */
export const WORKER_PREFETCH = 1;
