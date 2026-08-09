import { Test, TestingModule } from '@nestjs/testing';
import * as amqplib from 'amqplib';

import { mqConfig } from '@config/mq.config';

import { MqPublisherService } from './mq-publisher.service';
import { MqUnavailableError } from './mq.errors';
import { LOCATION_EVENT_TYPE, MQ_EXCHANGE } from './mq.constants';

jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

const amqpConnect = amqplib.connect as unknown as jest.Mock;

type PublishCallback = (error: Error | null) => void;

describe('MqPublisherService', () => {
  let service: MqPublisherService;
  const channel = {
    checkExchange: jest.fn(),
    publish: jest.fn(),
    on: jest.fn(),
    close: jest.fn(),
  };
  const connection = {
    createConfirmChannel: jest.fn(),
    on: jest.fn(),
    close: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    amqpConnect.mockResolvedValue(connection);
    connection.createConfirmChannel.mockResolvedValue(channel);
    channel.checkExchange.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MqPublisherService,
        {
          provide: mqConfig.KEY,
          useValue: { host: 'localhost', port: 5672, user: 'u', password: 'p' },
        },
      ],
    }).compile();

    service = module.get(MqPublisherService);
  });

  it('bootstrap connects and PASSIVELY verifies the exchange — the app never declares (ADR 0014/0015)', async () => {
    await service.onApplicationBootstrap();
    expect(channel.checkExchange).toHaveBeenCalledWith(MQ_EXCHANGE);
    const assertCalls = Object.keys(channel).filter((k) => k.startsWith('assert'));
    expect(assertCalls).toEqual([]); // no assertExchange/assertQueue on the mock at all
  });

  it('bootstrap FAILS when the topology is absent — boot must abort, not limp', async () => {
    channel.checkExchange.mockRejectedValue(new Error("no exchange 'loc.events'"));
    await expect(service.onApplicationBootstrap()).rejects.toThrow('loc.events');
  });

  it('publishes persistent + mandatory JSON with messageId and type, resolving on the confirm', async () => {
    await service.onApplicationBootstrap();
    channel.publish.mockImplementation(
      (_ex: string, _key: string, _buf: Buffer, _opts: object, cb: PublishCallback) => {
        cb(null);
        return true;
      },
    );

    await service.publish('user-42', { v: 1, eventId: 'e-1' }, 'e-1', LOCATION_EVENT_TYPE);

    const [exchange, routingKey, buffer, options] = channel.publish.mock.calls[0] as [
      string,
      string,
      Buffer,
      Record<string, unknown>,
    ];
    expect(exchange).toBe(MQ_EXCHANGE);
    expect(routingKey).toBe('user-42');
    expect(JSON.parse(buffer.toString())).toEqual({ v: 1, eventId: 'e-1' });
    expect(options).toMatchObject({
      persistent: true,
      mandatory: true,
      contentType: 'application/json',
      messageId: 'e-1',
      type: LOCATION_EVENT_TYPE,
    });
  });

  it('rejects with the transient marker when not connected', async () => {
    await expect(service.publish('u', {}, 'id', LOCATION_EVENT_TYPE)).rejects.toMatchObject({
      transientPublishFailure: true,
    });
  });

  it('rejects with the transient marker on a broker nack', async () => {
    await service.onApplicationBootstrap();
    channel.publish.mockImplementation(
      (_ex: string, _key: string, _buf: Buffer, _opts: object, cb: PublishCallback) => {
        cb(new Error('nack'));
        return true;
      },
    );
    await expect(service.publish('u', {}, 'id', LOCATION_EVENT_TYPE)).rejects.toBeInstanceOf(
      MqUnavailableError,
    );
  });

  it('rejects when the confirm never arrives (timeout) — queue depth is never the signal', async () => {
    jest.useFakeTimers();
    await service.onApplicationBootstrap();
    channel.publish.mockImplementation(() => true); // callback never invoked
    const attempt = service.publish('u', {}, 'id', LOCATION_EVENT_TYPE);
    const assertion = expect(attempt).rejects.toMatchObject({ transientPublishFailure: true });
    await jest.advanceTimersByTimeAsync(5_500);
    await assertion;
    jest.useRealTimers();
  });
});
