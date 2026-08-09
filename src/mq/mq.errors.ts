/**
 * A publish that could not be confirmed — broker down, channel gone, nack, or
 * confirm timeout. Transient and retryable by construction: the client's next
 * adaptive ping re-sends the position. The marker property is what
 * AllExceptionsFilter keys on to answer 503 + Retry-After instead of 500.
 */
export class MqUnavailableError extends Error {
  readonly transientPublishFailure = true;

  constructor(reason: string) {
    super(`message broker unavailable: ${reason}`);
    this.name = 'MqUnavailableError';
  }
}
