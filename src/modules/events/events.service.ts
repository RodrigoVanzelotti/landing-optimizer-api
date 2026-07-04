import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.module';
import { ClickHouseService, type EventRow } from '../analytics/clickhouse/clickhouse.service';
import { scrubProps, sanitizePath, type Envelope } from './event-scrub';

interface SiteAuth {
  siteId: string;
  tenantId: string;
  active: boolean;
  origins: string[];
}

const NIL = '00000000-0000-0000-0000-000000000000';
const SITE_CACHE_TTL = 60;
const RATE_LIMIT = 600; // events batches per window
const RATE_WINDOW = 60;

/**
 * Development/edge-fallback ingestion. Validates the ingest key + origin, rate
 * limits, scrubs PII, pseudonymizes the session id with a daily salt, and
 * writes rows to ClickHouse. In production a Cloudflare Worker fronts this path.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly ch: ClickHouseService,
  ) {}

  async ingest(
    envelope: Envelope,
    origin: string | undefined,
    ip: string | undefined,
  ): Promise<'ok' | 'unauthorized' | 'rate_limited'> {
    const site = await this.resolveSite(envelope.siteId, envelope.ik);
    if (!site || !site.active) return 'unauthorized';
    if (!this.originAllowed(site, origin)) return 'unauthorized';

    const ipHash = this.hash(`${ip ?? 'unknown'}:${this.dailySalt()}`);
    const allowed = await this.redis.allow(
      `rl:evt:${site.siteId}:${ipHash.slice(0, 12)}`,
      RATE_LIMIT,
      RATE_WINDOW,
    );
    if (!allowed) return 'rate_limited';

    const sessionId = this.pseudoSession(envelope.sid, site.siteId);
    const now = new Date();
    const rows: EventRow[] = envelope.events.map((e) => ({
      event_time: fmt(now),
      tenant_id: site.tenantId,
      site_id: site.siteId,
      session_id: sessionId,
      event_name: e.n,
      page_path: sanitizePath(envelope.ctx.path),
      referrer_host: envelope.ctx.ref.slice(0, 255),
      device_category: envelope.ctx.dev,
      browser_category: envelope.ctx.br,
      country: '', // populated by the edge only where legally safe
      is_bot: 0,
      experiment_id: e.exp ?? NIL,
      variant_id: e.var ?? NIL,
      section_id: (e.sec ?? '').slice(0, 64),
      scroll_depth: e.sd ?? 0,
      dwell_ms: e.dw ?? 0,
      value: e.val ?? 0,
      props: scrubProps(e.p),
    }));

    try {
      await this.ch.insertEvents(rows);
    } catch {
      // Never surface storage errors to the browser; drop the batch.
      this.logger.warn('event batch dropped after insert failure');
    }
    return 'ok';
  }

  private async resolveSite(siteId: string, ingestKey: string): Promise<SiteAuth | null> {
    const cacheKey = `site:auth:${siteId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as SiteAuth;
        return parsed.siteId === siteId && this.constantTimeEq(ingestKeyOf(parsed), ingestKey)
          ? parsed
          : this.verifyFromDb(siteId, ingestKey, cacheKey);
      } catch {
        /* fall through */
      }
    }
    return this.verifyFromDb(siteId, ingestKey, cacheKey);
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

  private originAllowed(site: SiteAuth, origin: string | undefined): boolean {
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
  private pseudoSession(sid: string, siteId: string): string {
    return this.hash(`${sid}:${siteId}:${this.dailySalt()}`).slice(0, 32);
  }

  private dailySalt(): string {
    const day = new Date().toISOString().slice(0, 10);
    return this.hash(`${day}:lo-session-salt`).slice(0, 16);
  }

  private hash(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  private constantTimeEq(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
}

function ingestKeyOf(auth: SiteAuth & { ik?: string }): string {
  return auth.ik ?? '';
}

/** Convert a Date to a ClickHouse DateTime64(3) literal. */
function fmt(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
