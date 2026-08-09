import { randomUUID } from 'node:crypto';

import { Injectable, UnprocessableEntityException } from '@nestjs/common';

import { MqPublisherService } from '@app/mq/mq-publisher.service';
import { LOCATION_EVENT_SCHEMA_VERSION, LOCATION_EVENT_TYPE } from '@app/mq/mq.constants';

import { MAX_ACCURACY_METERS } from './locations.constants';
import { LocationAcceptedDto, ReportLocationDto } from './dto';

/**
 * The wire schema N4C consumes — versioned (`v`) so the worker can branch when the
 * shape evolves. Everything the worker needs and cannot recover later travels here:
 * `receivedAt` above all (under backlog the worker processes minutes late, and the
 * log timestamp must be when the SYSTEM accepted the event — decision 8); `accuracy`
 * travels even though nothing persists it, so the worker may re-gate.
 */
export interface LocationEventV1 {
  v: typeof LOCATION_EVENT_SCHEMA_VERSION;
  eventId: string;
  userId: string;
  deviceId: string | null;
  seq: number | null;
  lat: number;
  lng: number;
  accuracy: number | null;
  capturedAt: string | null;
  receivedAt: string;
}

/**
 * N4B (ADR 0015): the API's whole job — validate (DTO layer), gate, stamp, publish,
 * acknowledge. No database, no transition result. The routing key is the RAW userId:
 * the consistent-hash exchange hashes the key itself (N4A's placement proof used raw
 * ids); pre-hashing here would just hash twice and desync us from that proof.
 */
@Injectable()
export class LocationIngestService {
  constructor(private readonly mqPublisher: MqPublisherService) {}

  async accept(dto: ReportLocationDto): Promise<LocationAcceptedDto> {
    // ADR 0010 gate, unchanged and still at the edge: a reading this uncertain is
    // rejected before it costs a publish. The worker MAY re-gate (accuracy travels).
    if (dto.accuracy !== undefined && dto.accuracy > MAX_ACCURACY_METERS) {
      throw new UnprocessableEntityException(
        `accuracy ${dto.accuracy}m exceeds the usable maximum of ${MAX_ACCURACY_METERS}m: a reading this uncertain cannot be checked against area boundaries`,
      );
    }

    const eventId = randomUUID();
    const event: LocationEventV1 = {
      v: LOCATION_EVENT_SCHEMA_VERSION,
      eventId,
      userId: dto.userId,
      deviceId: dto.deviceId ?? null,
      seq: dto.seq ?? null,
      lat: dto.lat,
      lng: dto.lng,
      accuracy: dto.accuracy ?? null,
      // ADR 0010: capturedAt replaces observedAt; deprecated alias honored,
      // capturedAt winning when both are sent — resolved HERE so the worker
      // never sees the alias.
      capturedAt: dto.capturedAt ?? dto.observedAt ?? null,
      receivedAt: new Date().toISOString(),
    };

    await this.mqPublisher.publish(dto.userId, event, eventId, LOCATION_EVENT_TYPE);
    return { eventId };
  }
}
