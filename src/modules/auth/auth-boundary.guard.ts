import { CanActivate, ExecutionContext, ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppEnv } from '../../config/env';
import { RedisService } from '../../common/redis/redis.module';

@Injectable()
export class AuthBoundaryGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppEnv, true>, private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    const origin = req.headers.origin;
    const origins = this.config.get('DASHBOARD_ORIGIN', { infer: true }).split(',').map(value => new URL(value.trim()).origin);
    if ((origin && !origins.includes(origin)) || req.headers['sec-fetch-site'] === 'cross-site') {
      throw new ForbiddenException('Untrusted authentication origin');
    }
    const action = context.getHandler().name;
    if (!['login', 'register', 'resetPassword', 'refresh'].includes(action)) return true;
    // Use the socket peer, never an attacker-supplied forwarding header.
    const source = createHash('sha256').update(req.socket.remoteAddress ?? 'unknown').digest('hex');
    if (!await this.redis.allow(`rl:auth:${action}:${source}`, 120, 60)) throw new HttpException('Too many authentication requests', 429);
    const body = req.body as { email?: unknown } | undefined;
    if (action === 'login' && typeof body?.email === 'string') {
      const account = createHash('sha256').update(body.email.trim().toLowerCase()).digest('hex');
      if (!await this.redis.allow(`rl:login:${account}`, 10, 900)) throw new HttpException('Too many login attempts; try again later', 429);
    }
    return true;
  }
}
