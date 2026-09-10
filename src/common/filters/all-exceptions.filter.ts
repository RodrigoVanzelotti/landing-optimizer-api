import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import {
  cleanLogValue,
  requestIdOf,
  requestPath,
  safeReason,
  type RequestContext,
} from '../logging/request-context';
import { Logger } from '../logging/logger';

const logger = Logger('AllExceptionsFilter');

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
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<RequestContext>();
    const requestId = requestIdOf(req);

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
        message = httpMessage(r['message'], exception.message);
        if (r['errors']) details = r['errors'];
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Map known DB constraint errors to the API contract without leaking internals.
      const mapped = mapPrismaError(exception);
      status = mapped.status;
      code = mapCode(status);
      message = mapped.message;
    } else if (isHttpStatusError(exception)) {
      status = exception.statusCode;
      code = mapCode(status);
      message = status < 500 ? cleanLogValue(exception.message) : 'Internal server error';
    }

    const body: ErrorBody = { error: { code, message, ...(details ? { details } : {}) } };
    void res
      .status(status)
      .header('content-type', 'application/json')
      .header('X-Request-ID', requestId)
      .send(body);

    const user = req.user;
    const reason = exceptionReason(exception, message);
    const log = {
      method: req.method,
      path: requestPath(req),
      status,
      code,
      reason,
      request_id: requestId,
      tenant_id: user?.tenantId ?? null,
      actor_user_id: user?.userId ?? null,
    };
    if (status >= 500) {
      logger.exception('request_failed', exception, log);
    } else {
      logger.warn('request_failed', log);
    }
  }
}

function httpMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(String).join('; ');
  return fallback;
}

function exceptionReason(exception: unknown, message: string): string {
  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    return `PrismaClientKnownRequestError:${exception.code}`;
  }
  if (exception instanceof HttpException) {
    return `${exception.name}:${cleanLogValue(message)}`;
  }
  return safeReason(exception);
}

function isHttpStatusError(
  exception: unknown,
): exception is { statusCode: number; message: string } {
  if (!(exception instanceof Error)) return false;
  const statusCode = (exception as Error & { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599;
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

/** Maps Prisma constraint errors to the API contract with safe, generic messages. */
function mapPrismaError(e: Prisma.PrismaClientKnownRequestError): {
  status: number;
  message: string;
} {
  switch (e.code) {
    case 'P2002':
      return { status: HttpStatus.CONFLICT, message: 'Resource already exists' };
    case 'P2025':
      return { status: HttpStatus.NOT_FOUND, message: 'Resource not found' };
    case 'P2003':
      return { status: HttpStatus.BAD_REQUEST, message: 'Related resource does not exist' };
    default:
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
  }
}
