import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import {
  requestIdOf,
  requestPath,
  type RequestContext,
} from './request-context';
import { Logger } from './logger';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const logger = Logger('TransactionLoggingInterceptor');

@Injectable()
export class TransactionLoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestContext>();
    const response = http.getResponse<FastifyReply>();
    const requestId = requestIdOf(request);
    const path = requestPath(request);
    const startedAt = performance.now();

    response.header('X-Request-ID', requestId);

    return next.handle().pipe(
      tap(() => {
        if (!shouldLogSuccess(request.method, path)) return;
        const user = request.user;
        logger.info('transaction_succeeded', {
          method: request.method,
          path,
          status: response.statusCode,
          duration_ms: Math.round(performance.now() - startedAt),
          request_id: requestId,
          tenant_id: user?.tenantId ?? null,
          actor_user_id: user?.userId ?? null,
        });
      }),
    );
  }
}

function shouldLogSuccess(method: string, path: string): boolean {
  if (!MUTATING_METHODS.has(method)) return false;
  return path !== '/v1/events' && path !== '/events';
}
