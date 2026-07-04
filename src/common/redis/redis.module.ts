import {
  Global,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AppEnv } from '../../config/env';

/**
 * Thin Redis wrapper used for signed-config caching and token-bucket rate
 * limiting. Fails soft: callers treat Redis outages as cache misses.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: ConfigService<AppEnv, true>) {
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    this.client.on('error', (err) => this.logger.warn(`Redis error: ${err.message}`));
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds) await this.client.set(key, value, 'EX', ttlSeconds);
      else await this.client.set(key, value);
    } catch {
      /* cache write is best-effort */
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch {
      /* ignore */
    }
  }

  /**
   * Fixed-window token bucket. Returns true when the request is allowed.
   */
  async allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    try {
      const count = await this.client.incr(key);
      if (count === 1) await this.client.expire(key, windowSeconds);
      return count <= limit;
    } catch {
      return true; // fail open for availability; edge has its own limits
    }
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
