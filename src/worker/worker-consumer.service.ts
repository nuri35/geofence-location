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

import { PARTITION_QUEUE_PREFIX } from './worker.constants';

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
 *
 * EXECUTION MODEL (N5A, ADR 0017): per-user promise chains. Each message is
 * appended to its user's chain — same user strictly sequential (ordering), and
 * DIFFERENT users concurrent, which removes the head-of-line blocking prefetch 1
 * imposed. Every task acks/nacks its OWN delivery at its OWN completion; a
 * drained chain is removed from the map (identity-checked, so a chain created
 * concurrently for the same user is never deleted by the old chain's cleanup).
 * Prefetch is configuration (WORKER_PREFETCH): it no longer guards ordering,
 * only the in-flight budget per partition and the crash-redelivery burst.
 */
@Injectable()
export class WorkerConsumerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerConsumerService.name);
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private closing = false;
  private readonly consumerTags: string[] = [];

  /**
   * userId -> tail of that user's processing chain (N5A). Entries are removed
   * when the chain drains; the removal compares identity so it can never delete
   * a NEWER chain created for the same user while cleanup was pending.
   */
  private readonly userChains = new Map<string, Promise<void>>();

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
    // Per-consumer limit (global=false): the in-flight budget per partition.
    // Ordering no longer depends on this — the per-user chains own it (ADR 0017).
    await channel.prefetch(this.worker.prefetch, false);

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
      const consumer = await channel.consume(queue, (message) => {
        if (message !== null) {
          void this.handle(channel, queue, message);
        }
      });
      this.consumerTags.push(consumer.consumerTag);
    }
    this.logger.log(
      `consuming ${this.worker.partitions.length} partition(s): ${this.worker.partitions.join(', ')} (prefetch ${this.worker.prefetch}, per-user chains)`,
    );
  }

  /**
   * Graceful shutdown (ADR 0017): stop deliveries FIRST (cancel every consumer),
   * then drain the in-flight chains — each task still acks/nacks on the open
   * channel — and only then close. Closing under in-flight work would strand
   * half-processed messages in the redelivery path for no reason.
   */
  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    try {
      for (const tag of this.consumerTags) {
        await this.channel?.cancel(tag);
      }
    } catch {
      // Channel already dead: deliveries have stopped by definition.
    }
    await Promise.allSettled([...this.userChains.values()]);
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {
      // Broker already gone: nothing to close cleanly.
    }
  }

  /** Observable for tests and ops: number of users with a live processing chain. */
  get activeChainCount(): number {
    return this.userChains.size;
  }

  /**
   * Parse, then append to the user's chain. Returns the completion of THIS
   * message's processing (tests await it; production fire-and-forgets).
   */
  private handle(
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
      return Promise.resolve();
    }

    return this.enqueue(event.userId, () => this.processEvent(channel, queue, message, event));
  }

  /**
   * The N5A chain append. Same user: strictly after the previous message —
   * ordering. Different users: independent chains — concurrency. The tail is
   * error-proofed (processEvent never throws, but a defect there must not
   * poison the user's next message), and cleanup deletes the map entry only if
   * it still IS this tail — the race where a new message arrives just as the
   * chain drains resolves in the new chain's favor.
   */
  private enqueue(userId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.userChains.get(userId) ?? Promise.resolve();
    const tail = previous.then(task).catch((error: unknown) => {
      this.logger.error(
        `chain task for ${userId} escaped its own error handling: ${String(error)}`,
      );
    });
    this.userChains.set(userId, tail);
    void tail.then(() => {
      if (this.userChains.get(userId) === tail) {
        this.userChains.delete(userId);
      }
    });
    return tail;
  }

  /**
   * Processes ONE message and settles ITS delivery: each task acks/nacks its own
   * delivery tag at its own completion — with many in flight, no task ever
   * touches another's tag, which is what keeps ack-after-commit true per message.
   */
  private async processEvent(
    channel: amqp.Channel,
    queue: string,
    message: amqp.ConsumeMessage,
    event: LocationEventV1,
  ): Promise<void> {
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
