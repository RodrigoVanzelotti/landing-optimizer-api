import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.module';
import { newId } from '../../common/crypto/ids';
import { ClickHouseService, type EventRow } from '../analytics/clickhouse/clickhouse.service';
import {
  parsePageMapPayload,
  sanitizePath,
  sanitizeSelector,
  scrubProps,
  type Envelope,
  type WireEvent,
} from './event-scrub';
import { SiteAuthService } from './site-auth.service';
import { Logger } from '../../common/logging/logger';

const logger = Logger('EventsService');

const NIL = '00000000-0000-0000-0000-000000000000';
const RATE_LIMIT = 600; // events batches per window
const RATE_WINDOW = 60;
const PAGE_MAP_WRITE_LIMIT = 30; // Postgres page-map upserts per site per hour
const PAGE_MAP_WINDOW = 3600;

/**
 * Development/edge-fallback ingestion. Validates the ingest key + origin, rate
 * limits, scrubs PII, pseudonymizes the session id with a daily salt, and
 * writes rows to ClickHouse. Structural `page_map` events are split off and
 * persisted to Postgres (they describe the page, not visitor behavior).
 * In production a Cloudflare Worker fronts this path.
 */
@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly ch: ClickHouseService,
    private readonly siteAuth: SiteAuthService,
  ) {}

  async ingest(
    envelope: Envelope,
    origin: string | undefined,
    ip: string | undefined,
    requestId?: string,
  ): Promise<'ok' | 'unauthorized' | 'rate_limited'> {
    const site = await this.siteAuth.resolveSite(envelope.siteId, envelope.ik);
    if (!site || !site.active) return 'unauthorized';
    if (!this.siteAuth.originAllowed(site, origin)) return 'unauthorized';

    const ipHash = this.siteAuth.hash(`${ip ?? 'unknown'}:${this.siteAuth.dailySalt()}`);
    const allowed = await this.redis.allow(
      `rl:evt:${site.siteId}:${ipHash.slice(0, 12)}`,
      RATE_LIMIT,
      RATE_WINDOW,
    );
    if (!allowed) return 'rate_limited';

    // Structural page_map events are persisted relationally, not as analytics
    // rows (their nested payload would be destroyed by scrubProps anyway).
    const pageMaps = envelope.events.filter((e) => e.n === 'page_map');
    const behavioral = envelope.events.filter((e) => e.n !== 'page_map');

    if (pageMaps.length > 0) {
      await this.persistPageMap(site.siteId, pageMaps, requestId);
    }
    if (behavioral.length === 0) return 'ok';

    const sessionId = this.siteAuth.pseudoSession(envelope.sid, site.siteId);
    const now = new Date();
    const rows: EventRow[] = behavioral.map((e) => ({
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
      selector: sanitizeSelector(e.sel),
      goal: (e.goal ?? '').slice(0, 64),
      scroll_depth: e.sd ?? 0,
      dwell_ms: e.dw ?? 0,
      value: e.val ?? 0,
      props: scrubProps(e.p),
    }));

    try {
      await this.ch.insertEvents(rows);
    } catch (err) {
      // Never surface storage errors to the browser; drop the batch. This is
      // the ONLY log record for the incident (ClickHouseService does not log
      // insert errors), so it carries every fact needed to trace it.
      logger.exception('event_batch_dropped', err, {
        dependency: 'clickhouse',
        site_id: site.siteId,
        events: rows.length,
        request_id: requestId ?? null,
      });
    }
    return 'ok';
  }

  /**
   * Upsert the latest structural page map per (site, path). Rate limited per
   * site so a hot page cannot amplify into a Postgres write storm; the map
   * only changes when the page does, so dropped duplicates cost nothing.
   */
  private async persistPageMap(
    siteId: string,
    events: WireEvent[],
    requestId?: string,
  ): Promise<void> {
    try {
      const first = events[0];
      const payload = first ? parsePageMapPayload(first.p) : null;
      if (!payload) return;

      const allowed = await this.redis.allow(
        `rl:pm:${siteId}`,
        PAGE_MAP_WRITE_LIMIT,
        PAGE_MAP_WINDOW,
      );
      if (!allowed) return;

      await this.prisma.pageMap.upsert({
        where: { siteId_urlPath: { siteId, urlPath: payload.path } },
        create: {
          id: newId(),
          siteId,
          urlPath: payload.path,
          map: payload as object,
        },
        update: {
          map: payload as object,
          capturedAt: new Date(),
        },
      });
    } catch (err) {
      // Structural persistence is best-effort; behavioral ingestion continues.
      logger.exception('page_map_dropped', err, {
        dependency: 'postgres',
        site_id: siteId,
        request_id: requestId ?? null,
      });
    }
  }
}

/** Convert a Date to a ClickHouse DateTime64(3) literal. */
function fmt(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
