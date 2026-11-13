import {
  Global,
  Injectable,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AppEnv } from '../../config/env';
import { safeReason } from '../logging/request-context';
import { Logger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';

const logger = Logger('RedisService');

/**
 * Thin Redis wrapper used for signed-config caching and token-bucket rate
 * limiting. Without Redis, caches miss and PostgreSQL enforces shared limits.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client?: Redis;

  constructor(config: ConfigService<AppEnv, true>, private readonly prisma: PrismaService) {
    const url = config.get('REDIS_URL', { infer: true });
    if (!url) return;
    this.client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    this.client.on('error', (err) =>
      logger.warn('dependency_error', {
        dependency: 'redis',
        reason: safeReason(err),
      }),
    );
  }

  async get(key: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.client) return;
    try {
      if (ttlSeconds) await this.client.set(key, value, 'EX', ttlSeconds);
      else await this.client.set(key, value);
    } catch {
      /* cache write is best-effort */
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client?.del(key);
    } catch {
      /* ignore */
    }
  }

  /**
   * Fixed-window token bucket. Returns true when the request is allowed.
   */
  async allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    if (this.client) {
      try {
        // Increment and expiry must be atomic, including when a request is interrupted.
        const count = await this.client.eval(
          "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return n",
          1, key, windowSeconds,
        );
        return Number(count) <= limit;
      } catch {
        // Keep shared protection when Redis is unavailable.
      }
    }
    await this.prisma.$executeRaw`DELETE FROM rate_limit WHERE expires_at < now()`;
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO rate_limit (key, count, expires_at)
      VALUES (${key}, 1, now() + ${windowSeconds} * interval '1 second')
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN rate_limit.expires_at <= now() THEN 1 ELSE rate_limit.count + 1 END,
        expires_at = CASE WHEN rate_limit.expires_at <= now() THEN EXCLUDED.expires_at ELSE rate_limit.expires_at END
      RETURNING count`;
    return rows[0]!.count <= limit;
  }

  onModuleDestroy(): void {
    this.client?.disconnect();
  }
}

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
