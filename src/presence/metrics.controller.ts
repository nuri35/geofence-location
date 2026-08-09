import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { PresenceMetricsService } from './presence-metrics.service';

/**
 * Minimal internal counters endpoint (ADR 0013 addendum) — per-instance, in-memory,
 * reset on restart, unversioned. Exists so the stale-cache exposure is observable
 * without an observability stack; enveloped like every other JSON endpoint.
 */
@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly presenceMetrics: PresenceMetricsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Per-instance presence-cache counters (internal; reset on restart). ' +
      'presence_change_path_noop_total is an UPPER BOUND on suppressed entries, not a count — ' +
      'read-aside races and stale-"changed" hits share the signature (ADR 0013).',
  })
  metrics(): Record<string, number> {
    return this.presenceMetrics.snapshot();
  }
}
