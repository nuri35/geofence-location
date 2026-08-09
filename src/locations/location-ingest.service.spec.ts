import { Test, TestingModule } from '@nestjs/testing';

import { MqPublisherService } from '@app/mq/mq-publisher.service';
import { LOCATION_EVENT_TYPE } from '@app/mq/mq.constants';

import { LocationIngestService, LocationEventV1 } from './location-ingest.service';

describe('LocationIngestService', () => {
  let service: LocationIngestService;
  const publish = jest.fn();

  const baseDto = { userId: 'user-1', lat: 41, lng: 29 };

  beforeEach(async () => {
    jest.clearAllMocks();
    publish.mockResolvedValue(undefined);
    const module: TestingModule = await Test.createTestingModule({
      providers: [LocationIngestService, { provide: MqPublisherService, useValue: { publish } }],
    }).compile();

    service = module.get(LocationIngestService);
  });

  const publishedEvent = (): LocationEventV1 =>
    (publish.mock.calls[0] as unknown[])[1] as LocationEventV1;

  it('publishes a v1 event with the RAW userId as routing key and returns its eventId', async () => {
    const result = await service.accept(baseDto);

    const [routingKey, event, messageId, type] = publish.mock.calls[0] as [
      string,
      LocationEventV1,
      string,
      string,
    ];
    expect(routingKey).toBe('user-1'); // the exchange hashes; we must not pre-hash
    expect(type).toBe(LOCATION_EVENT_TYPE);
    expect(event.v).toBe(1);
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(messageId).toBe(event.eventId);
    expect(result.eventId).toBe(event.eventId);
    expect(event).toMatchObject({ userId: 'user-1', lat: 41, lng: 29 });
    expect(new Date(event.receivedAt).toISOString()).toBe(event.receivedAt); // valid ISO instant
  });

  it('absent optionals travel as explicit nulls — the worker never guesses', async () => {
    await service.accept(baseDto);
    expect(publishedEvent()).toMatchObject({
      deviceId: null,
      seq: null,
      accuracy: null,
      capturedAt: null,
    });
  });

  it('resolves the deprecated observedAt alias BEFORE the wire — capturedAt wins when both are sent', async () => {
    await service.accept({ ...baseDto, observedAt: '2019-01-01T00:00:00Z' });
    expect(publishedEvent().capturedAt).toBe('2019-01-01T00:00:00Z');

    jest.clearAllMocks();
    publish.mockResolvedValue(undefined);
    await service.accept({
      ...baseDto,
      capturedAt: '2020-06-06T00:00:00Z',
      observedAt: '2019-01-01T00:00:00Z',
    });
    expect(publishedEvent().capturedAt).toBe('2020-06-06T00:00:00Z');
  });

  it('rejects unusable accuracy with 422 BEFORE any publish', async () => {
    await expect(service.accept({ ...baseDto, accuracy: 150 })).rejects.toMatchObject({
      status: 422,
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('a distinct eventId per request, but the same routing key for the same user', async () => {
    const first = await service.accept(baseDto);
    const second = await service.accept(baseDto);
    expect(first.eventId).not.toBe(second.eventId);
    const keys = (publish.mock.calls as Array<[string]>).map(([key]) => key);
    expect(keys).toEqual(['user-1', 'user-1']);
  });

  it('propagates publish failure — a lost event must NEVER be acknowledged as accepted', async () => {
    publish.mockRejectedValue(
      Object.assign(new Error('broker down'), { transientPublishFailure: true }),
    );
    await expect(service.accept(baseDto)).rejects.toMatchObject({ transientPublishFailure: true });
  });
});
