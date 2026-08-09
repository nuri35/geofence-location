import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type * as amqp from 'amqplib';

import { LocationsService } from '@app/locations/locations.service';
import { mqConfig } from '@config/mq.config';
import { workerConfig } from '@config/worker.config';

import { WorkerConsumerService } from './worker-consumer.service';

type Handle = (channel: unknown, queue: string, message: amqp.ConsumeMessage) => Promise<void>;

const makeMessage = (payload: object): amqp.ConsumeMessage =>
  ({ content: Buffer.from(JSON.stringify(payload)) }) as amqp.ConsumeMessage;

const baseEvent = {
  v: 1,
  eventId: 'e-1',
  userId: 'user-1',
  deviceId: null as string | null,
  seq: null as number | null,
  lat: 41,
  lng: 29,
  accuracy: null as number | null,
  capturedAt: null as string | null,
  receivedAt: '2026-08-09T10:00:00.000Z',
};

describe('WorkerConsumerService', () => {
  let service: WorkerConsumerService;
  let handle: Handle;
  const report = jest.fn();
  const dataSourceQuery = jest.fn();
  const channel = { ack: jest.fn(), nack: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    report.mockResolvedValue({ enteredAreaIds: [], duplicate: false });
    dataSourceQuery.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkerConsumerService,
        { provide: LocationsService, useValue: { report } },
        { provide: getDataSourceToken(), useValue: { query: dataSourceQuery } },
        { provide: mqConfig.KEY, useValue: { host: 'x', port: 5672, user: 'u', password: 'p' } },
        { provide: workerConfig.KEY, useValue: { partitions: [0, 1] } },
      ],
    }).compile();

    service = module.get(WorkerConsumerService);
    // The private handler, exercised directly: bootstrap wiring needs a live broker
    // and is covered by the worker-loop e2e.
    handle = (service as unknown as { handle: Handle }).handle.bind(service);
  });

  it("passes the message's receivedAt as recordedAt — never the worker's clock (decision 8)", async () => {
    await handle(channel, 'loc.events.p0', makeMessage(baseEvent));

    const [dto, recordedAt] = report.mock.calls[0] as [Record<string, unknown>, Date];
    expect(recordedAt).toEqual(new Date('2026-08-09T10:00:00.000Z'));
    expect(dto).toEqual({ userId: 'user-1', lat: 41, lng: 29 }); // nulls stay off the dto
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('never forwards deviceId/seq to the transition path — user_event_state stays read-only', async () => {
    dataSourceQuery.mockResolvedValue([]); // no prior row -> lastSeq 0
    await handle(
      channel,
      'loc.events.p0',
      makeMessage({ ...baseEvent, deviceId: 'phone-1', seq: 4 }),
    );

    const [dto] = report.mock.calls[0] as [Record<string, unknown>];
    expect(dto).not.toHaveProperty('deviceId');
    expect(dto).not.toHaveProperty('seq');
  });

  describe('lazy in-memory dedup (ADR 0016)', () => {
    const withSeq = (seq: number, eventId = `e-${seq}`): amqp.ConsumeMessage =>
      makeMessage({ ...baseEvent, eventId, deviceId: 'phone-1', seq });

    it('loads last_seq from the table once, then serves from memory', async () => {
      dataSourceQuery.mockResolvedValue([{ last_seq: '3' }]);

      await handle(channel, 'loc.events.p0', withSeq(3)); // <= 3: duplicate
      expect(report).not.toHaveBeenCalled();
      expect(channel.ack).toHaveBeenCalledTimes(1); // acked, not retried

      await handle(channel, 'loc.events.p0', withSeq(4)); // newer: processed
      expect(report).toHaveBeenCalledTimes(1);
      expect(dataSourceQuery).toHaveBeenCalledTimes(1); // table consulted exactly once
    });

    it('bumps the in-memory seq only AFTER success — a nacked message retries, not self-dedups', async () => {
      dataSourceQuery.mockResolvedValue([]);
      report.mockRejectedValueOnce(new Error('transient db failure'));

      await handle(channel, 'loc.events.p0', withSeq(5));
      expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);

      report.mockResolvedValue({ enteredAreaIds: [], duplicate: false });
      await handle(channel, 'loc.events.p0', withSeq(5)); // the redelivery
      expect(report).toHaveBeenCalledTimes(2); // NOT treated as duplicate
      expect(channel.ack).toHaveBeenCalledTimes(1);
    });
  });

  describe('per-user chains (N5A, ADR 0017)', () => {
    const forUser = (userId: string, eventId: string): amqp.ConsumeMessage =>
      makeMessage({ ...baseEvent, userId, eventId });

    it('same user is strictly sequential; different users run concurrently', async () => {
      const started: string[] = [];
      const resolvers = new Map<string, () => void>();
      report.mockImplementation((dto: { userId: string }) => {
        started.push(dto.userId);
        return new Promise<{ enteredAreaIds: string[]; duplicate: boolean }>((resolve) => {
          resolvers.set(dto.userId, () => resolve({ enteredAreaIds: [], duplicate: false }));
        });
      });

      const slow1 = handle(channel, 'loc.events.p0', forUser('ahmet', 'a-1'));
      const slow2 = handle(channel, 'loc.events.p0', forUser('ahmet', 'a-2'));
      const other = handle(channel, 'loc.events.p0', forUser('ayse', 'b-1'));
      await new Promise((resolve) => setImmediate(resolve));

      // ayse started WHILE ahmet's first message is still in flight — concurrency.
      // ahmet's second message has NOT started — same-user ordering.
      expect(started).toEqual(['ahmet', 'ayse']);

      resolvers.get('ayse')?.();
      await other;
      expect(started).toEqual(['ahmet', 'ayse']); // still only one ahmet start

      resolvers.get('ahmet')?.();
      await slow1;
      await new Promise((resolve) => setImmediate(resolve));
      expect(started).toEqual(['ahmet', 'ayse', 'ahmet']); // a-2 only after a-1 completed
      resolvers.get('ahmet')?.();
      await slow2;
    });

    it('each task acks its OWN delivery tag at its OWN completion', async () => {
      const first = forUser('u1', 'e-1');
      const second = forUser('u2', 'e-2');
      const resolvers: Array<() => void> = [];
      report.mockImplementation(
        () =>
          new Promise<{ enteredAreaIds: string[]; duplicate: boolean }>((resolve) => {
            resolvers.push(() => resolve({ enteredAreaIds: [], duplicate: false }));
          }),
      );

      const p1 = handle(channel, 'loc.events.p0', first);
      const p2 = handle(channel, 'loc.events.p0', second);
      await new Promise((resolve) => setImmediate(resolve));
      expect(channel.ack).not.toHaveBeenCalled(); // nothing acked before completion

      resolvers[1]?.(); // u2 finishes FIRST
      await p2;
      expect(channel.ack).toHaveBeenCalledTimes(1);
      expect(channel.ack).toHaveBeenNthCalledWith(1, second); // its own message, not u1's

      resolvers[0]?.();
      await p1;
      expect(channel.ack).toHaveBeenNthCalledWith(2, first);
    });

    it('a drained chain is removed; a chain re-created concurrently survives the old cleanup', async () => {
      await handle(channel, 'loc.events.p0', forUser('u-clean', 'e-1'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(service.activeChainCount).toBe(0); // drained -> removed
      channel.ack.mockClear(); // count the race part on its own

      // Race shape: enqueue a second message the moment the first's tail settles.
      const resolvers: Array<() => void> = [];
      report.mockImplementation(
        () =>
          new Promise<{ enteredAreaIds: string[]; duplicate: boolean }>((resolve) => {
            resolvers.push(() => resolve({ enteredAreaIds: [], duplicate: false }));
          }),
      );
      const p1 = handle(channel, 'loc.events.p0', forUser('u-race', 'e-1'));
      await new Promise((resolve) => setImmediate(resolve)); // task started, resolver registered
      resolvers[0]?.(); // e-1 settles -> its cleanup microtask is now pending
      const p2 = handle(channel, 'loc.events.p0', forUser('u-race', 'e-2')); // lands in the cleanup window
      await new Promise((resolve) => setImmediate(resolve));
      resolvers[1]?.();
      await Promise.all([p1, p2]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(service.activeChainCount).toBe(0); // both processed, nothing leaked
      expect(channel.ack).toHaveBeenCalledTimes(2); // e-2 was NOT lost to the cleanup race
    });

    it('shutdown cancels consumers FIRST, then drains in-flight work, then closes', async () => {
      // Inject the live handles bootstrap would have created (bootstrap itself
      // needs a real broker and is covered by the worker-loop e2e).
      const cancel = jest.fn().mockResolvedValue(undefined);
      const close = jest.fn().mockResolvedValue(undefined);
      const connectionClose = jest.fn().mockResolvedValue(undefined);
      const bootChannel = { cancel, close, ack: jest.fn(), nack: jest.fn() };
      const internals = service as unknown as {
        channel: unknown;
        connection: unknown;
        consumerTags: string[];
      };
      internals.channel = bootChannel;
      internals.connection = { close: connectionClose };
      internals.consumerTags.push('tag-0');

      let finish!: () => void;
      report.mockImplementation(
        (): Promise<{ enteredAreaIds: string[]; duplicate: boolean }> =>
          new Promise((resolve) => {
            finish = (): void => resolve({ enteredAreaIds: [], duplicate: false });
          }),
      );
      const inFlight = handle(bootChannel, 'loc.events.p0', forUser('u-drain', 'e-1'));
      await new Promise((resolve) => setImmediate(resolve));

      let shutdownDone = false;
      const shutdown = service.onApplicationShutdown().then(() => {
        shutdownDone = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(cancel).toHaveBeenCalledWith('tag-0'); // deliveries stopped first
      expect(shutdownDone).toBe(false); // still waiting on the in-flight chain
      expect(close).not.toHaveBeenCalled(); // channel stays open for the pending ack

      finish();
      await inFlight;
      await shutdown;
      expect(shutdownDone).toBe(true);
      expect(bootChannel.ack).toHaveBeenCalledTimes(1); // the in-flight work acked before close
      expect(close).toHaveBeenCalled();
    });
  });

  describe('failure routing', () => {
    it('acks and counts a stale-area FK violation — the ONE narrow exception', async () => {
      report.mockRejectedValue(
        Object.assign(new Error('insert failed'), {
          driverError: { code: '23503', constraint: 'fk_presence_area' },
        }),
      );

      await handle(channel, 'loc.events.p0', makeMessage(baseEvent));

      expect(channel.ack).toHaveBeenCalledTimes(1);
      expect(channel.nack).not.toHaveBeenCalled();
      expect(service.staleAreaDropCount).toBe(1);
    });

    it('nacks (requeue) every other failure — the delivery-limit path owns retries', async () => {
      report.mockRejectedValue(
        Object.assign(new Error('fk on something else'), {
          driverError: { code: '23503', constraint: 'fk_logs_user' },
        }),
      );
      await handle(channel, 'loc.events.p0', makeMessage(baseEvent));
      expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
      expect(channel.ack).not.toHaveBeenCalled();
      expect(service.staleAreaDropCount).toBe(0);
    });

    it('nacks malformed payloads and unsupported schema versions', async () => {
      await handle(channel, 'loc.events.p0', {
        content: Buffer.from('not-json{'),
      } as amqp.ConsumeMessage);
      await handle(channel, 'loc.events.p0', makeMessage({ ...baseEvent, v: 2 }));
      expect(channel.nack).toHaveBeenCalledTimes(2);
      expect(report).not.toHaveBeenCalled();
    });
  });
});
