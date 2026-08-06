import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

import { ResponseTransformInterceptor } from './response-transform.interceptor';

describe('ResponseTransformInterceptor', () => {
  it('wraps handler output in the standard envelope', async () => {
    const interceptor = new ResponseTransformInterceptor<{ hello: string }>();

    const context = {
      switchToHttp: (): { getResponse: () => { statusCode: number } } => ({
        getResponse: (): { statusCode: number } => ({ statusCode: 200 }),
      }),
    } as unknown as ExecutionContext;

    const next: CallHandler<{ hello: string }> = {
      handle: () => of({ hello: 'world' }),
    };

    const result = await firstValueFrom(interceptor.intercept(context, next));

    expect(result.statusCode).toBe(200);
    expect(result.data).toEqual({ hello: 'world' });
    expect(typeof result.timestamp).toBe('string');
  });
});
