/** Decision 14: user_id is varchar(64) — free-form because auth is a non-goal, but bounded. */
export const USER_ID_MAX_LENGTH = 64;

/**
 * ADR 0010: a GPS reading with an error radius above this cannot answer
 * "inside or outside" for any boundary the user is near — rejecting beats
 * computing a confident answer from unreliable input. 422, not 400: the
 * request is well-formed; its content is unusable.
 */
export const MAX_ACCURACY_METERS = 100;
