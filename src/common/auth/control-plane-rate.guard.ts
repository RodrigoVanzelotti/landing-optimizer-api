import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import type { RequestContext } from '../logging/request-context';
import { RedisService } from '../redis/redis.module';

@Injectable()
export class ControlPlaneRateGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestContext>();
    if (!request.user) return true;
    if (request.method === 'POST' && ['/auth/logout', '/v1/auth/logout'].includes(request.url.split('?')[0]!)) return true;
    const userId = request.user.userId;
    if (!await this.redis.allow(`rl:control:${userId}`, 300, 60)) throw new HttpException('Too many requests', 429);
    if (request.method === 'POST' && /\/sites\/[^/]+\/ai\/analyze(?:\?|$)/.test(request.url) &&
        !await this.redis.allow(`rl:ai:${userId}`, 5, 60)) throw new HttpException('Too many AI analyses; try again later', 429);
    return true;
  }
}
