import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorResponseBody {
  statusCode: number;
  timestamp: string;
  path: string;
  message: string | string[];
}

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter<HttpException> {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const statusCode = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    const message =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : (((exceptionResponse as Record<string, unknown>).message as
            string | string[] | undefined) ?? exception.message);

    const body: ErrorResponseBody = {
      statusCode,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
    };

    response.status(statusCode).json(body);
  }
}
