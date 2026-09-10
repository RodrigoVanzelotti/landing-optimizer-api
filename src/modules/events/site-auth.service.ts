import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.module';

/**
 * Shared authentication for the public edge surface (events + snapshots):
 * resolves a site by id, verifies the public ingest key in constant time, and
 * checks the origin allowlist. Results are cached briefly in Redis so hot
 * ingestion paths avoid a Postgres round trip per batch.
 */

export interface SiteAuth {
  siteId: string;
  tenantId: string;
  active: boolean;
  origins: string[];
}

const SITE_CACHE_TTL = 60;

@Injectable()
export class SiteAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async resolveSite(siteId: string, ingestKey: string): Promise<SiteAuth | null> {
    const cacheKey = `site:auth:${siteId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as SiteAuth & { ik?: string };
        return parsed.siteId === siteId && this.constantTimeEq(parsed.ik ?? '', ingestKey)
          ? parsed
          : this.verifyFromDb(siteId, ingestKey, cacheKey);
      } catch {
        /* fall through */
      }
    }
    return this.verifyFromDb(siteId, ingestKey, cacheKey);
  }

  originAllowed(site: SiteAuth, origin: string | undefined): boolean {
    if (site.origins.length === 0) return true; // no allowlist configured yet
    if (!origin) return false;
    try {
      const normalized = new URL(origin).origin;
      return site.origins.includes(normalized);
    } catch {
      return false;
    }
  }

  /** Non-reversible, daily-rotating, per-site session pseudonym. */
  pseudoSession(sid: string, siteId: string): string {
    return this.hash(`${sid}:${siteId}:${this.dailySalt()}`).slice(0, 32);
  }

  dailySalt(): string {
    const day = new Date().toISOString().slice(0, 10);
    return this.hash(`${day}:lo-session-salt`).slice(0, 16);
  }

  hash(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  private async verifyFromDb(
    siteId: string,
    ingestKey: string,
    cacheKey: string,
  ): Promise<SiteAuth | null> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: { origins: true },
    });
    if (!site) return null;
    if (!this.constantTimeEq(site.ingestKey, ingestKey)) return null;

    const auth: SiteAuth & { ik: string } = {
      siteId: site.id,
      tenantId: site.tenantId,
      active: site.status === 'active',
      origins: site.origins.map((o) => o.origin),
      ik: site.ingestKey,
    };
    await this.redis.set(cacheKey, JSON.stringify(auth), SITE_CACHE_TTL);
    return auth;
  }

  private constantTimeEq(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
}
