import { ArgumentsHost, BadRequestException, ServiceUnavailableException } from '@nestjs/common';

import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  const status = jest.fn();
  const json = jest.fn();
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url: '/test-path', method: 'POST' }),
    }),
  } as unknown as ArgumentsHost;

  beforeEach(() => {
    jest.clearAllMocks();
    status.mockReturnValue({ json });
    filter = new AllExceptionsFilter();
  });

  const sentBody = (): Record<string, unknown> => json.mock.calls[0][0] as Record<string, unknown>;

  it('shapes a standard HttpException into the house body', () => {
    filter.catch(new BadRequestException(['lat out of range']), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(sentBody()).toMatchObject({
      statusCode: 400,
      path: '/test-path',
      message: ['lat out of range'],
    });
    expect(typeof sentBody().timestamp).toBe('string');
  });

  it('passes a structured message-less payload through verbatim (Terminus health results)', () => {
    const terminusPayload = {
      status: 'error',
      info: {},
      error: { database: { status: 'down', message: 'connect ECONNREFUSED' } },
      details: { database: { status: 'down', message: 'connect ECONNREFUSED' } },
    };
    filter.catch(new ServiceUnavailableException(terminusPayload), host);

    expect(status).toHaveBeenCalledWith(503);
    expect(sentBody()).toEqual(terminusPayload); // untouched — no flattening, no house wrapper
  });

  it('shapes exposed 4xx middleware errors (http-errors convention) with their own message', () => {
    const payloadTooLarge = Object.assign(new Error('request entity too large'), {
      statusCode: 413,
      expose: true,
    });
    filter.catch(payloadTooLarge, host);

    expect(status).toHaveBeenCalledWith(413);
    expect(sentBody()).toMatchObject({
      statusCode: 413,
      path: '/test-path',
      message: 'request entity too large',
    });
  });

  it('returns a generic 500 for unknown exceptions and leaks nothing from them', () => {
    const driverError = new Error(
      'connect ECONNREFUSED 127.0.0.1:5433 — SELECT "area_id" FROM "user_area_presence" WHERE password=secret',
    );
    filter.catch(driverError, host);

    expect(status).toHaveBeenCalledWith(500);
    const body = sentBody();
    expect(body).toMatchObject({
      statusCode: 500,
      path: '/test-path',
      message: 'Internal server error',
    });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(body)).not.toContain('user_area_presence');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('does not treat expose=false or 5xx middleware errors as client-safe', () => {
    const internal = Object.assign(new Error('secret internals'), {
      statusCode: 500,
      expose: false,
    });
    filter.catch(internal, host);

    expect(status).toHaveBeenCalledWith(500);
    expect(sentBody().message).toBe('Internal server error');
  });
});
