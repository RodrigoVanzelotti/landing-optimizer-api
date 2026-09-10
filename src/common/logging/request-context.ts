import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '../auth/auth.types';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export type RequestContext = FastifyRequest & {
  requestId?: string;
  user?: AuthUser;
};

export function requestIdOf(request: RequestContext): string {
  if (request.requestId) return request.requestId;
  const value = firstHeader(request.headers['x-request-id']);
  request.requestId = value && SAFE_REQUEST_ID.test(value) ? value : randomUUID();
  return request.requestId;
}

export function requestPath(request: FastifyRequest): string {
  return cleanLogValue(request.url.split('?')[0] ?? '/', 300);
}

export function safeReason(error: unknown): string {
  if (!(error instanceof Error)) return cleanLogValue(String(error), 300);
  const message = cleanLogValue(error.message, 300);
  return message ? `${error.name}:${message}` : error.name;
}

export function cleanLogValue(value: string, maxLength = 300): string {
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, maxLength);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
