import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from './auth.types';

/** Injects the authenticated principal into a controller method parameter. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AuthUser }>();
    if (!req.user) throw new Error('CurrentUser used on an unauthenticated route');
    return req.user;
  },
);
