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

export type SiteAuthFailure =
  | 'unknown_site'
  | 'invalid_key'
  | 'site_paused'
  | 'origin_not_allowed';

export type SiteAuthResult =
  | { ok: true; site: SiteAuth }
  | { ok: false; reason: SiteAuthFailure };

const SITE_CACHE_TTL = 60;

@Injectable()
export class SiteAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async authorize(
    siteId: string,
    ingestKey: string,
    origin: string | undefined,
  ): Promise<SiteAuthResult> {
    const resolved = await this.resolveSiteDetailed(siteId, ingestKey);
    if (!resolved.ok) return resolved;
    if (!resolved.site.active) {
      return { ok: false, reason: 'site_paused' };
    }
    if (!this.originAllowed(resolved.site, origin)) {
      return { ok: false, reason: 'origin_not_allowed' };
    }
    return resolved
  }

  async resolveSite(siteId: string, ingestKey: string): Promise<SiteAuth | null> {
    const result = await this.resolveSiteDetailed(siteId, ingestKey);
    return result.ok ? result.site : null;
  }

  async resolveSiteDetailed(siteId: string, ingestKey: string): Promise<SiteAuthResult> {
    const cacheKey = `site:auth:${siteId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as SiteAuth & { ik?: string };
        if (parsed.siteId === siteId && this.constantTimeEq(parsed.ik ?? '', ingestKey)) {
          return { ok: true, site: parsed };
        }
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
  ): Promise<SiteAuthResult> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: { origins: true },
    });
    if (!site) return { ok: false, reason: 'unknown_site' };
    if (!this.constantTimeEq(site.ingestKey, ingestKey)) return { ok: false, reason: 'invalid_key' };

    const auth: SiteAuth & { ik: string } = {
      siteId: site.id,
      tenantId: site.tenantId,
      active: site.status === 'active',
      origins: site.origins.map((o) => o.origin),
      ik: site.ingestKey,
    };
    await this.redis.set(cacheKey, JSON.stringify(auth), SITE_CACHE_TTL);
    return { ok: true, site: auth };
  }

  private constantTimeEq(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
}
