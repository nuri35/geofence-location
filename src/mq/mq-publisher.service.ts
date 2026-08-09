import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import * as amqp from 'amqplib';

import { mqConfig } from '@config/mq.config';

import {
  MQ_EXCHANGE,
  PUBLISH_CONFIRM_TIMEOUT_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from './mq.constants';
import { MqUnavailableError } from './mq.errors';

/**
 * The one AMQP writer (ADR 0015). Owns a single connection + confirm channel.
 *
 * The N4A rule is enforced here: the application NEVER declares topology — at
 * bootstrap it passively verifies the exchange exists and ABORTS BOOT if not
 * (an API that accepts events it cannot publish would 503 every request while
 * looking healthy). Publishes are persistent + mandatory and resolve only on the
 * broker's confirm — queue-depth stats lag 5–7 s (measured, ADR 0014) and are
 * never used as a signal.
 */
@Injectable()
export class MqPublisherService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MqPublisherService.name);
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.ConfirmChannel | null = null;
  private closing = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;

  constructor(@Inject(mqConfig.KEY) private readonly config: ConfigType<typeof mqConfig>) {}

  async onApplicationBootstrap(): Promise<void> {
    // First connect must succeed and must SEE the topology — fail the boot loudly
    // rather than start an ingester with nowhere to put events.
    await this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
    }
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {
      // Broker already gone: nothing to close cleanly.
    }
  }

  /**
   * Publishes persistently to the consistent-hash exchange and resolves ONLY on
   * the broker's confirm. Rejections are always MqUnavailableError — the filter
   * maps it to 503 + Retry-After; the client re-sends on its next adaptive ping.
   */
  publish(routingKey: string, payload: object, messageId: string, type: string): Promise<void> {
    const channel = this.channel;
    if (channel === null) {
      return Promise.reject(new MqUnavailableError('not connected'));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new MqUnavailableError(`confirm not received within ${PUBLISH_CONFIRM_TIMEOUT_MS}ms`),
          ),
        PUBLISH_CONFIRM_TIMEOUT_MS,
      );
      try {
        channel.publish(
          MQ_EXCHANGE,
          routingKey,
          Buffer.from(JSON.stringify(payload)),
          {
            persistent: true,
            // Unroutable messages (no partition bound — topology damage) come back
            // as basic.return and are logged loud in connect() below.
            mandatory: true,
            contentType: 'application/json',
            messageId,
            type,
            timestamp: Math.floor(Date.now() / 1000),
          },
          (error) => {
            clearTimeout(timer);
            if (error) {
              reject(new MqUnavailableError('broker rejected the publish (nack)'));
            } else {
              resolve();
            }
          },
        );
      } catch (error) {
        clearTimeout(timer);
        reject(new MqUnavailableError(error instanceof Error ? error.message : String(error)));
      }
    });
  }

  private async connect(): Promise<void> {
    const connection = await amqp.connect({
      hostname: this.config.host,
      port: this.config.port,
      username: this.config.user,
      password: this.config.password,
    });
    const channel = await connection.createConfirmChannel();
    // Passive check — throws if absent. Topology belongs to N4A's declarator job;
    // an app instance that "helpfully" declared it could race a deployment with a
    // different partition count (ADR 0014's immutability guard exists for this).
    await channel.checkExchange(MQ_EXCHANGE);

    connection.on('error', (error: Error) => {
      this.logger.warn(`amqp connection error: ${error.message}`);
    });
    connection.on('close', () => {
      this.connection = null;
      this.channel = null;
      if (!this.closing) {
        this.logger.warn('amqp connection closed; publishes fail fast (503) until reconnect');
        this.scheduleReconnect();
      }
    });
    channel.on('error', (error: Error) => {
      this.logger.warn(`amqp channel error: ${error.message}`);
    });
    // A mandatory message with no route means the partition bindings are GONE —
    // topology damage, not load. The publish was still confirmed, so this is the
    // only trace: make it unmissable.
    channel.on('return', (msg: amqp.ConsumeMessage) => {
      this.logger.error(
        `UNROUTABLE publish returned (routing key ${msg.fields.routingKey}) — partition bindings missing; run the mq-topology job`,
      );
    });

    this.connection = connection;
    this.channel = channel;
    this.reconnectAttempt = 0;
    this.logger.log(`amqp connected; exchange '${MQ_EXCHANGE}' verified (passive)`);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error: Error) => {
        this.logger.warn(`amqp reconnect failed: ${error.message}`);
        this.scheduleReconnect();
      });
    }, delay);
  }
}
