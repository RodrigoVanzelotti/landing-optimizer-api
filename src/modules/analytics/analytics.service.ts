import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClickHouseService } from './clickhouse/clickhouse.service';
import { analyzeExperiment, type VariantResult, type VariantStat } from './stats';

export interface OverviewResult {
  pageViews: number;
  conversions: number;
  conversionRate: number;
  ctaClicks: number;
  formSubmits: number;
}

export interface HeatmapElement {
  selector: string;
  ctaClicks: number;
  deadClicks: number;
  rageClicks: number;
  hoverMs: number;
  hoverEvents: number;
}

export interface HeatmapResult {
  pageViews: number;
  elements: HeatmapElement[];
  scrollDepth: { bucket: number; reached: number; pct: number }[];
}

/**
 * Read-only analytics over ClickHouse. Every query is scoped by tenant_id and
 * site_id injected server-side — the client can never supply those directly.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ch: ClickHouseService,
  ) {}

  async overview(
    tenantId: string,
    siteId: string,
    from: string,
    to: string,
  ): Promise<OverviewResult> {
    await this.requireSite(tenantId, siteId);
    const rows = await this.ch.query<{ event_name: string; c: string }>(
      `SELECT event_name, count() AS c
       FROM events
       WHERE tenant_id = {tenantId:UUID} AND site_id = {siteId:UUID}
         AND event_time BETWEEN {from:DateTime64} AND {to:DateTime64}
       GROUP BY event_name`,
      { tenantId, siteId, from, to },
    );
    const map = new Map(rows.map((r) => [r.event_name, Number(r.c)]));
    const pageViews = map.get('page_view') ?? 0;
    const conversions = map.get('conversion') ?? 0;
    return {
      pageViews,
      conversions,
      conversionRate: pageViews > 0 ? conversions / pageViews : 0,
      ctaClicks: map.get('cta_click') ?? 0,
      formSubmits: map.get('form_submit') ?? 0,
    };
  }

  async funnel(tenantId: string, siteId: string): Promise<{ event: string; count: number }[]> {
    await this.requireSite(tenantId, siteId);
    const rows = await this.ch.query<{ event_name: string; c: string }>(
      `SELECT event_name, count() AS c
       FROM events
       WHERE tenant_id = {tenantId:UUID} AND site_id = {siteId:UUID}
       GROUP BY event_name ORDER BY c DESC`,
      { tenantId, siteId },
    );
    return rows.map((r) => ({ event: r.event_name, count: Number(r.c) }));
  }

  async sections(
    tenantId: string,
    siteId: string,
  ): Promise<
    { section: string; views: number; deadClicks: number; rageClicks: number; dwellMs: number }[]
  > {
    await this.requireSite(tenantId, siteId);
    const rows = await this.ch.query<{
      section_id: string;
      views: string;
      dead_clicks: string;
      rage_clicks: string;
      dwell_ms_total: string;
    }>(
      `SELECT section_id,
              sum(views) AS views,
              sum(dead_clicks) AS dead_clicks,
              sum(rage_clicks) AS rage_clicks,
              sum(dwell_ms_total) AS dwell_ms_total
       FROM mv_section_performance
       WHERE tenant_id = {tenantId:UUID} AND site_id = {siteId:UUID}
       GROUP BY section_id ORDER BY views DESC`,
      { tenantId, siteId },
    );
    return rows.map((r) => ({
      section: r.section_id,
      views: Number(r.views),
      deadClicks: Number(r.dead_clicks),
      rageClicks: Number(r.rage_clicks),
      dwellMs: Number(r.dwell_ms_total),
    }));
  }

  /**
   * Element-anchored behavior metrics for one page path, powering the
   * dashboard heatmap layers (clicks, hover attention, frustration, scroll
   * depth). Selectors were sanitized at ingestion; they key into the geometry
   * stored with the page snapshot.
   */
  async heatmap(
    tenantId: string,
    siteId: string,
    path: string,
    from: string,
    to: string,
  ): Promise<HeatmapResult> {
    await this.requireSite(tenantId, siteId);
    const scope = `tenant_id = {tenantId:UUID} AND site_id = {siteId:UUID}
         AND page_path = {path:String}
         AND event_time BETWEEN {from:DateTime64} AND {to:DateTime64}`;
    const params = { tenantId, siteId, path, from, to };

    const [elementRows, scrollRows, viewRows] = await Promise.all([
      this.ch.query<{
        selector: string;
        cta_clicks: string;
        dead_clicks: string;
        rage_clicks: string;
        hover_ms: string;
        hover_events: string;
      }>(
        `SELECT selector,
                countIf(event_name = 'cta_click')  AS cta_clicks,
                countIf(event_name = 'dead_click') AS dead_clicks,
                countIf(event_name = 'rage_click') AS rage_clicks,
                sumIf(dwell_ms, event_name = 'hover') AS hover_ms,
                countIf(event_name = 'hover')      AS hover_events
         FROM events
         WHERE ${scope} AND selector != ''
         GROUP BY selector
         ORDER BY (cta_clicks + dead_clicks + rage_clicks) DESC, hover_ms DESC
         LIMIT 200`,
        params,
      ),
      this.ch.query<{ bucket: number; reached: string }>(
        `SELECT scroll_depth AS bucket, count() AS reached
         FROM events
         WHERE ${scope} AND event_name = 'scroll_depth'
         GROUP BY bucket ORDER BY bucket`,
        params,
      ),
      this.ch.query<{ c: string }>(
        `SELECT count() AS c FROM events WHERE ${scope} AND event_name = 'page_view'`,
        params,
      ),
    ]);

    const pageViews = Number(viewRows[0]?.c ?? 0);
    return {
      pageViews,
      elements: elementRows.map((r) => ({
        selector: r.selector,
        ctaClicks: Number(r.cta_clicks),
        deadClicks: Number(r.dead_clicks),
        rageClicks: Number(r.rage_clicks),
        hoverMs: Number(r.hover_ms),
        hoverEvents: Number(r.hover_events),
      })),
      scrollDepth: scrollRows.map((r) => ({
        bucket: Number(r.bucket),
        reached: Number(r.reached),
        pct: pageViews > 0 ? Number(r.reached) / pageViews : 0,
      })),
    };
  }

  async experimentResults(
    tenantId: string,
    experimentId: string,
  ): Promise<{ experimentId: string; variants: VariantResult[] }> {
    const experiment = await this.prisma.experiment.findUnique({
      where: { id: experimentId },
      include: { variants: true },
    });
    if (!experiment) throw new NotFoundException('Experiment not found');
    if (experiment.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access');

    const rows = await this.ch.query<{
      variant_id: string;
      exposures: string;
      conversions: string;
    }>(
      `SELECT variant_id,
              sum(exposures) AS exposures,
              sum(conversions) AS conversions
       FROM mv_experiment_stats
       WHERE tenant_id = {tenantId:UUID} AND experiment_id = {experimentId:UUID}
       GROUP BY variant_id`,
      { tenantId, experimentId },
    );
    const byId = new Map(rows.map((r) => [r.variant_id, r]));

    const stats: VariantStat[] = experiment.variants.map((v) => {
      const row = byId.get(v.id);
      return {
        variantId: v.id,
        isControl: v.isControl,
        exposures: row ? Number(row.exposures) : 0,
        conversions: row ? Number(row.conversions) : 0,
      };
    });
    return { experimentId, variants: analyzeExperiment(stats) };
  }

  private async requireSite(tenantId: string, siteId: string): Promise<void> {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFoundException('Site not found');
    if (site.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access');
  }
}
