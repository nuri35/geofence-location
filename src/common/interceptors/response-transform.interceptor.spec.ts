import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

import { SkipResponseTransform } from '../decorators';
import {
  ResponseTransformInterceptor,
  TransformedResponse,
} from './response-transform.interceptor';

class PlainController {
  handle(): void {}
}

@SkipResponseTransform()
class SkippedController {
  handle(): void {}
}

interface ControllerClass {
  new (): unknown;
  prototype: { handle: () => void };
}

const makeContext = (controller: ControllerClass): ExecutionContext =>
  ({
    switchToHttp: (): { getResponse: () => { statusCode: number } } => ({
      getResponse: (): { statusCode: number } => ({ statusCode: 200 }),
    }),
    getHandler: (): (() => void) => controller.prototype.handle,
    getClass: (): ControllerClass => controller,
  }) as unknown as ExecutionContext;

describe('ResponseTransformInterceptor', () => {
  const interceptor = new ResponseTransformInterceptor<{ hello: string }>(new Reflector());

  const next: CallHandler<{ hello: string }> = {
    handle: () => of({ hello: 'world' }),
  };

  it('wraps handler output in the standard envelope', async () => {
    const result = (await firstValueFrom(
      interceptor.intercept(makeContext(PlainController), next),
    )) as TransformedResponse<{ hello: string }>;

    expect(result.statusCode).toBe(200);
    expect(result.data).toEqual({ hello: 'world' });
    expect(typeof result.timestamp).toBe('string');
  });

  it('passes the payload through untouched when @SkipResponseTransform is set', async () => {
    const result = await firstValueFrom(
      interceptor.intercept(makeContext(SkippedController), next),
    );

    expect(result).toEqual({ hello: 'world' });
    expect(result).not.toHaveProperty('data');
  });
});
