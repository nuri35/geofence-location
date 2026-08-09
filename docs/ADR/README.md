# Architecture Decision Records

| # | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-postgis-extension-via-migration.md) | Provision the PostGIS extension via a TypeORM migration | Accepted | 2026-08-06 |
| [0002](0002-presence-table-source-of-truth.md) | Presence table in PostgreSQL as the source of truth for area membership | Accepted | 2026-08-07 |
| [0003](0003-spatial-query-strategy.md) | Spatial query strategy: PostGIS with a GIST index, `ST_Covers` | Accepted (annotated: per-ping PIP moves in-memory per ADR 0011) | 2026-08-07 |
| [0004](0004-no-queue.md) | No message queue on the write path | Superseded by 0011 (scope change) | 2026-08-07 |
| [0005](0005-time-and-ordering-policy.md) | Time and ordering policy | Accepted | 2026-08-07 |
| [0006](0006-read-endpoint-pagination.md) | Read endpoint pagination: keyset for logs, offset for areas | Accepted | 2026-08-07 |
| [0007](0007-presence-read-strategy.md) | Presence read strategy: folded lock+read wins | Superseded by 0011 for the target; governs the synchronous system | 2026-08-07 |
| [0008](0008-disable-migration-generate.md) | Disable `migration:generate`; schema SQL is written by hand | Accepted | 2026-08-08 |
| [0009](0009-connection-and-query-bounds.md) | Bound connection acquisition, statement execution, and idle transactions | Accepted | 2026-08-08 |
| [0010](0010-adaptive-payload-contract.md) | Adaptive payload contract with per-device deduplication | Accepted | 2026-08-09 |
| [0011](0011-partitioned-async-architecture.md) | Partitioned asynchronous architecture (target; phases N2–N6) | Accepted as direction | 2026-08-09 |
| [0012](0012-in-memory-spatial-index.md) | In-memory spatial index with versioned snapshot (Phase N2) | Accepted | 2026-08-09 |
| [0013](0013-presence-cache-no-change-fast-path.md) | Redis presence cache with a no-change fast path (Phase N3) | Accepted | 2026-08-09 |
| [0014](0014-rabbitmq-topology.md) | RabbitMQ topology with consistent-hash partitioning (Phase N4A) | Accepted | 2026-08-09 |
| [0015](0015-publisher-contract.md) | The API becomes a publisher: 202 contract and the location event schema (Phase N4B) | Accepted | 2026-08-09 |
| [0016](0016-worker.md) | The worker: static partition ownership, lazy dedup, ack-after-commit (Phase N4C) | Accepted | 2026-08-09 |
| [0017](0017-per-user-parallelism.md) | Per-user parallelism inside a partition (Phase N5A) | Accepted | 2026-08-09 |
