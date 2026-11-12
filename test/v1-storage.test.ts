import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../src/common/redis/redis.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { EventsService } from '../src/modules/events/events.service';
import { EnvelopeSchema } from '../src/modules/events/event-scrub';

describe('V1 shared rate limits', () => {
  it('rejects exhausted limits and fails closed when PostgreSQL is unavailable', async () => {
    const prisma = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([{ count: 601 }]),
    };
    const service = new RedisService(new ConfigService({}), prisma as unknown as PrismaService);
    expect(await service.get('missing')).toBeNull();
    expect(await service.allow('site:ip', 600, 60)).toBe(false);
    prisma.$queryRaw.mockRejectedValue(new Error('database unavailable'));
    await expect(service.allow('site:ip', 600, 60)).rejects.toThrow('database unavailable');
  });
});

it('does not acknowledge a batch that failed to persist', async () => {
  const service = new EventsService(
    { conversionGoal: { findMany: vi.fn().mockResolvedValue([]) } } as never,
    { allow: vi.fn().mockResolvedValue(true) } as never,
    { insertEvents: vi.fn().mockRejectedValue(new Error('storage unavailable')) } as never,
    {
      resolveSite: vi.fn().mockResolvedValue({ active: true, siteId: 'site', tenantId: 'tenant' }),
      originAllowed: () => true, hash: () => 'hash', dailySalt: () => 'salt', pseudoSession: () => 'opaque',
    } as never,
  );
  const envelope = EnvelopeSchema.parse({
    v: 1, siteId: '018f6b2a-0000-7000-8000-000000000000', ik: 'test', sid: 'session',
    ctx: { path: '/' }, events: [{ n: 'page_view', t: 0 }],
  });
  await expect(service.ingest(envelope, 'https://example.com', '127.0.0.1')).rejects.toThrow('Event storage unavailable');
});
