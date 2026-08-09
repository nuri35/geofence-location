import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import * as amqp from 'amqplib';
import { DataSource } from 'typeorm';

import { LocationEventV1 } from '@app/locations/location-ingest.service';
import { LocationsService } from '@app/locations/locations.service';
import { USER_EVENT_STATE_TABLE } from '@app/locations/entities/user-event-state.entity';
import { LOCATION_EVENT_SCHEMA_VERSION } from '@app/mq/mq.constants';
import { mqConfig } from '@config/mq.config';
import { workerConfig } from '@config/worker.config';

import { PARTITION_QUEUE_PREFIX, WORKER_PREFETCH } from './worker.constants';

interface LastSeqRow {
  last_seq: string;
}

/** Postgres foreign-key violation. */
const PG_FOREIGN_KEY_VIOLATION = '23503';

/**
 * The N4C worker (ADR 0016): consumes its statically assigned partitions and runs
 * the transition path N4B parked. amqplib directly, NOT Nest's RMQ transport —
 * ServerRMQ asserts its queue by default (the app must never declare, ADR 0014),
 * nacks undeliverable messages with requeue=false (bypassing the delivery-limit
 * path), and consumes exactly one queue per instance (this worker owns several).
 *
 * ACK discipline: ack only after the transaction committed (report() resolves
 * post-commit); the no-change fast path opens no transaction and acks directly.
 * A worker dying mid-transition rolls back and the message is redelivered clean.
 * Prefetch is 1 per consumer — RECORDED AS TEMPORARY: higher prefetch would let
 * two messages for one user process concurrently and break per-user ordering;
 * the per-user parallelism that makes it safe is N5's work.
 */
@Injectable()
export class WorkerConsumerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerConsumerService.name);
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private closing = false;

  /**
   * Lazy in-memory dedup (ADR 0016): `userId:deviceId` -> highest seq PROCESSED.
   * Loaded from user_event_state on first sight (the table is read-only here — N1's
   * per-event write is gone; N5 restores writes as rebalance checkpoints). Updated
   * only AFTER successful processing, so a nacked message is retried, not treated
   * as its own duplicate. A worker crash loses this Map; redelivered duplicates are
   * absorbed by ON CONFLICT in the transaction — correctness never rests here.
   */
  private readonly lastSeqByDevice = new Map<string, number>();

  /** Stale-area drops (ADR 0012's recorded hazard): acked, logged, counted — never retried. */
  staleAreaDropCount = 0;
  /** Messages processed to completion (ack sent). Exposed for tests and ops logging. */
  processedCount = 0;

  constructor(
    private readonly locationsService: LocationsService,
    @Inject(mqConfig.KEY) private readonly mq: ConfigType<typeof mqConfig>,
    @Inject(workerConfig.KEY) private readonly worker: ConfigType<typeof workerConfig>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const connection = await amqp.connect({
      hostname: this.mq.host,
      port: this.mq.port,
      username: this.mq.user,
      password: this.mq.password,
    });
    const channel = await connection.createChannel();
    // Per-consumer limit (global=false): one unacked message per partition queue —
    // serial within a partition (ordering), parallel across partitions.
    await channel.prefetch(WORKER_PREFETCH, false);

    // Passive verification only — the topology belongs to N4A's declarator job.
    // A missing partition queue aborts boot loudly instead of silently declaring.
    for (const partition of this.worker.partitions) {
      await channel.checkQueue(`${PARTITION_QUEUE_PREFIX}${partition}`);
    }

    connection.on('error', (error: Error) => {
      this.logger.warn(`amqp connection error: ${error.message}`);
    });
    connection.on('close', () => {
      if (!this.closing) {
        // N4C keeps failover simple: ownership is static and rebalancing is N5's
        // work, so a lost broker connection is fatal — the supervisor restarts us.
        this.logger.error('amqp connection closed unexpectedly; exiting for restart');
        process.exit(1);
      }
    });

    this.connection = connection;
    this.channel = channel;

    for (const partition of this.worker.partitions) {
      const queue = `${PARTITION_QUEUE_PREFIX}${partition}`;
      await channel.consume(queue, (message) => {
        if (message !== null) {
          void this.handle(channel, queue, message);
        }
      });
    }
    this.logger.log(
      `consuming ${this.worker.partitions.length} partition(s): ${this.worker.partitions.join(', ')} (prefetch ${WORKER_PREFETCH})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {
      // Broker already gone: nothing to close cleanly.
    }
  }

  private async handle(
    channel: amqp.Channel,
    queue: string,
    message: amqp.ConsumeMessage,
  ): Promise<void> {
    let event: LocationEventV1;
    try {
      event = JSON.parse(message.content.toString()) as LocationEventV1;
      if (event.v !== LOCATION_EVENT_SCHEMA_VERSION) {
        throw new Error(`unsupported schema version ${String(event.v)}`);
      }
    } catch (error) {
      // Unparseable/unknown-version: the normal nack path — the delivery-limit
      // policy bounds redeliveries and dead-letters it for inspection.
      this.logger.warn(`${queue}: malformed message: ${String(error)}`);
      channel.nack(message, false, true);
      return;
    }

    try {
      // Dedup gate — read-only against the table, then memory (ADR 0016).
      if (await this.isDuplicate(event)) {
        channel.ack(message);
        return;
      }

      // The parked N4B transition path, unchanged. deviceId/seq are deliberately
      // NOT passed: the worker's Map replaced the in-transaction dedup, and
      // omitting them keeps user_event_state read-only (no per-event write).
      await this.locationsService.report(
        {
          userId: event.userId,
          lat: event.lat,
          lng: event.lng,
          ...(event.accuracy === null ? {} : { accuracy: event.accuracy }),
          ...(event.capturedAt === null ? {} : { capturedAt: event.capturedAt }),
        },
        // decision 8 under backlog: the log records when the system ACCEPTED the
        // event — the API's receivedAt stamp — never the worker's clock.
        new Date(event.receivedAt),
      );

      this.rememberSeq(event); // only after success — a nack must retry, not self-dedup
      this.processedCount += 1;
      channel.ack(message); // after commit: report() resolves post-COMMIT (ADR 0002)
    } catch (error) {
      if (this.isStaleAreaViolation(error)) {
        // The one narrow exception (ADR 0012's recorded hazard): the area was
        // deleted between the snapshot and the write. Retrying cannot help.
        this.staleAreaDropCount += 1;
        this.processedCount += 1;
        this.logger.warn(
          `${queue}: dropped event ${event.eventId} for ${event.userId}: referenced area no longer exists (stale snapshot window)`,
        );
        channel.ack(message);
        return;
      }
      this.logger.warn(`${queue}: processing failed for ${event.eventId}: ${String(error)}`);
      channel.nack(message, false, true); // delivery-limit bounds this toward the DLQ
    }
  }

  /**
   * TIGHT by design: only a foreign-key violation on the presence table's area
   * reference qualifies. Anything broader would swallow real failures into acks.
   */
  private isStaleAreaViolation(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const driver = (error as { driverError?: { code?: string; constraint?: string } }).driverError;
    return (
      driver?.code === PG_FOREIGN_KEY_VIOLATION &&
      typeof driver.constraint === 'string' &&
      driver.constraint.includes('area')
    );
  }

  private async isDuplicate(event: LocationEventV1): Promise<boolean> {
    if (event.deviceId === null || event.seq === null) {
      return false; // legacy events carry no dedup identity
    }
    const key = `${event.userId}:${event.deviceId}`;
    let lastSeq = this.lastSeqByDevice.get(key);
    if (lastSeq === undefined) {
      const rows = await this.dataSource.query<LastSeqRow[]>(
        `SELECT "last_seq" FROM "${USER_EVENT_STATE_TABLE}" WHERE "user_id" = $1 AND "device_id" = $2`,
        [event.userId, event.deviceId],
      );
      lastSeq = rows.length > 0 ? Number(rows[0].last_seq) : 0;
      this.lastSeqByDevice.set(key, lastSeq);
    }
    return event.seq <= lastSeq;
  }

  private rememberSeq(event: LocationEventV1): void {
    if (event.deviceId === null || event.seq === null) {
      return;
    }
    const key = `${event.userId}:${event.deviceId}`;
    const known = this.lastSeqByDevice.get(key) ?? 0;
    if (event.seq > known) {
      this.lastSeqByDevice.set(key, event.seq);
    }
  }
}
