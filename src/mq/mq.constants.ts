/** The consistent-hash exchange declared by N4A's topology job (ADR 0014). */
export const MQ_EXCHANGE = 'loc.events';

/** AMQP message `type` property — the schema name+version consumers dispatch on. */
export const LOCATION_EVENT_TYPE = 'location.v1';

/** Schema version carried INSIDE the payload so a consumer can branch without headers. */
export const LOCATION_EVENT_SCHEMA_VERSION = 1;

/**
 * Publisher-confirm ceiling. A confirm slower than this is treated as a failed
 * publish (503 to the client, who re-sends on the next adaptive ping) — the same
 * fail-fast philosophy as the ADR 0009 bounds.
 */
export const PUBLISH_CONFIRM_TIMEOUT_MS = 5_000;

export const RECONNECT_BASE_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 5_000;
