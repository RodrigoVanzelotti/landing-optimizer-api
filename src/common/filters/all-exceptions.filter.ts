import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Normalizes all errors to the RFC7807-ish contract in docs/API_CONTRACTS.md.
 * Never leaks stack traces or internal messages for 5xx responses.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<FastifyRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'internal_error';
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      code = mapCode(status);
      if (typeof response === 'string') {
        message = response;
      } else if (response && typeof response === 'object') {
        const r = response as Record<string, unknown>;
        message = (r['message'] as string) ?? exception.message;
        if (r['errors']) details = r['errors'];
      }
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled: ${exception.message}`, exception.stack);
    }

    const body: ErrorBody = { error: { code, message, ...(details ? { details } : {}) } };
    void res
      .status(status)
      .header('content-type', 'application/json')
      .send(body);

    if (status >= 500) {
      this.logger.error(`${req.method} ${req.url} -> ${status} ${code}`);
    }
  }
}

function mapCode(status: number): string {
  switch (status) {
    case 400:
      return 'validation_error';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'internal_error' : 'error';
  }
}
