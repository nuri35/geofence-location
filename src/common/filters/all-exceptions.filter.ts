import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorResponseBody {
  statusCode: number;
  timestamp: string;
  path: string;
  message: string | string[];
}

/**
 * The API's single error instrument (fix from the 2026-08-07 smoke test). One
 * catch-all rather than a second filter beside the old @Catch(HttpException) one:
 * Nest resolves global filters by iterating them and using the first whose @Catch
 * metadata matches, so two filters make the contract depend on registration order —
 * one filter with explicit branches keeps the whole contract readable in one place.
 *
 * Branches, in order:
 * 1. HttpException carrying a structured object WITHOUT a `message` key — passed
 *    through verbatim. These payloads were built deliberately (Terminus health
 *    results are the live case: flattening them cost the `database: down` detail
 *    exactly when an operator needed it).
 * 2. Any other HttpException — the house shape; its message is intentional and safe.
 * 3. Exposed client errors from Express middleware (http-errors convention:
 *    4xx + expose=true; body-parser's 413 is the live case) — house shape, own message.
 * 4. Everything else — internal. The client gets the house shape with a generic
 *    message and NOTHING from the exception (driver errors carry SQL fragments and
 *    connection details); the log gets the method, path, message, and stack.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'object' && payload !== null && !('message' in payload)) {
        response.status(statusCode).json(payload);
        return;
      }

      const message =
        typeof payload === 'string'
          ? payload
          : (((payload as Record<string, unknown>).message as string | string[] | undefined) ??
            exception.message);
      response.status(statusCode).json(this.body(statusCode, request.url, message));
      return;
    }

    const exposed = this.asExposedClientError(exception);
    if (exposed !== null) {
      response
        .status(exposed.statusCode)
        .json(this.body(exposed.statusCode, request.url, exposed.message));
      return;
    }

    const detail = exception instanceof Error ? exception.message : String(exception);
    const stack = exception instanceof Error ? exception.stack : undefined;
    this.logger.error(`unhandled exception on ${request.method} ${request.url}: ${detail}`, stack);
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(this.body(HttpStatus.INTERNAL_SERVER_ERROR, request.url, 'Internal server error'));
  }

  /** http-errors convention used by Express middleware: expose=true marks the message client-safe. */
  private asExposedClientError(exception: unknown): { statusCode: number; message: string } | null {
    if (typeof exception !== 'object' || exception === null) {
      return null;
    }
    const candidate = exception as {
      status?: unknown;
      statusCode?: unknown;
      expose?: unknown;
      message?: unknown;
    };
    const statusCode = candidate.statusCode ?? candidate.status;
    if (
      candidate.expose === true &&
      typeof statusCode === 'number' &&
      Number.isInteger(statusCode) &&
      statusCode >= 400 &&
      statusCode < 500 &&
      typeof candidate.message === 'string'
    ) {
      return { statusCode, message: candidate.message };
    }
    return null;
  }

  private body(statusCode: number, path: string, message: string | string[]): ErrorResponseBody {
    return {
      statusCode,
      timestamp: new Date().toISOString(),
      path,
      message,
    };
  }
}
