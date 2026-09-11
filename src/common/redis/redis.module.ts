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

const logger = Logger('RedisService');

/**
 * Atomic fixed-window increment. Sets the window TTL when the key is new and
 * self-heals any counter that lost its TTL (TTL < 0 means no expiry), so a
 * window can never become permanent.
 */
const ALLOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

/**
 * Thin Redis wrapper used for signed-config caching and token-bucket rate
 * limiting. Fails soft: callers treat Redis outages as cache misses.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService<AppEnv, true>) {
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
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
   *
   * INCR + EXPIRE run atomically in one Lua script, and a missing TTL is
   * re-set on every call. The previous two-command version could leave the
   * counter key immortal if the process failed between INCR and EXPIRE —
   * after `limit` total increments the key would rate-limit its site
   * PERMANENTLY (observed as ingestion silently stopping after a while).
   */
  async allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    try {
      const count = (await this.client.eval(
        ALLOW_SCRIPT,
        1,
        key,
        String(windowSeconds),
      )) as number;
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
