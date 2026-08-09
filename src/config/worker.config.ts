import { registerAs } from '@nestjs/config';

import { ConfigNamespace, EnvKey } from './config.constants';

export interface WorkerConfig {
  /** Partition indices this worker owns — static external assignment (ADR 0016). */
  partitions: number[];
  /**
   * Per-consumer prefetch (ADR 0017). Per-user ordering no longer depends on it —
   * the per-user promise chains do that — so it is purely a throughput/exposure
   * knob: in-flight budget per partition, and the redelivery burst after a crash.
   */
  prefetch: number;
}

/**
 * Accepts "0-3" (inclusive range), "0,2,5" (list), or a mix ("0-3,7"). Ownership
 * is configuration, not broker-side single-active-consumer, because N5 builds
 * rebalancing on ownership the process actually knows about.
 */
export const parsePartitionSpec = (spec: string): number[] => {
  const partitions = new Set<number>();
  for (const part of spec.split(',')) {
    const range = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (range === null) {
      throw new Error(`invalid WORKER_PARTITIONS segment '${part}' (use "0-3" or "0,2,5")`);
    }
    const from = parseInt(range[1], 10);
    const to = range[2] === undefined ? from : parseInt(range[2], 10);
    if (to < from) {
      throw new Error(`invalid WORKER_PARTITIONS range '${part}': end before start`);
    }
    for (let i = from; i <= to; i += 1) {
      partitions.add(i);
    }
  }
  return [...partitions].sort((a, b) => a - b);
};

export const workerConfig = registerAs(ConfigNamespace.Worker, (): WorkerConfig => ({
  // Dev default covers all 8 dev partitions with one worker; production sets
  // explicit slices of the 256 (e.g. "0-63" across four workers).
  partitions: parsePartitionSpec(process.env[EnvKey.WorkerPartitions] ?? '0-7'),
  prefetch: parseInt(process.env[EnvKey.WorkerPrefetch] ?? '16', 10),
}));
