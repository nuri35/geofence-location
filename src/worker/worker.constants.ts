/** Partition queue name prefix — the N4A topology's loc.events.p{i}. */
export const PARTITION_QUEUE_PREFIX = 'loc.events.p';

// ADR 0016's temporary `WORKER_PREFETCH = 1` is resolved: prefetch is now
// configuration (WORKER_PREFETCH env, ADR 0017) because per-user ordering moved
// from "one message at a time" to the per-user promise chains.
