import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClickHouseService } from './clickhouse/clickhouse.service';
import { buildReport, reportRange, SESSION_REPORT_SQL, type DailyMetric, type ReportQuery } from './report';
import { impactQuery, buildExperimentImpact, type ImpactRow, type ExperimentImpactQuery } from './experiment-impact';
import { buildExperimentResults, experimentResultsQuery, type ResultRow } from './experiment-results';
import { storedReport } from './experiment-report';
import { evaluateEvidence, type EvaluationPlan } from '../experiments/experiment-evidence';

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

  async report(tenantId: string, siteId: string, timeframe: ReportQuery['timeframe']) {
    const site = await this.requireSite(tenantId, siteId);
    const range = reportRange(timeframe);
    const retentionFrom = this.ch.retentionDays === null ? 0 : Date.parse(range.to) - this.ch.retentionDays * 864e5;
    const createdDay = new Date(site.createdAt).toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const availableFrom = new Date(Math.max(Date.parse(createdDay), retentionFrom)).toISOString();
    const params = {
      tenantId, siteId,
      from: range.from.replace('T', ' ').replace('Z', ''),
      to: range.to.replace('T', ' ').replace('Z', ''),
      previousFrom: (range.previousFrom > availableFrom ? range.previousFrom : availableFrom).replace('T', ' ').replace('Z', ''),
    };
    const [events, sessions, sections] = await Promise.all([
      this.ch.query<DailyMetric>(
        `SELECT CAST(event_time AS DATE) AS date, event_name AS metric, count() AS count
         FROM events WHERE tenant_id = {tenantId:UUID} AND site_id = {siteId:UUID}
           AND event_time >= {previousFrom:DateTime64} AND event_time < {to:DateTime64} AND is_bot = 0
         GROUP BY date, event_name ORDER BY date`, params),
      this.ch.query<DailyMetric>(SESSION_REPORT_SQL, params),
      this.ch.query<{ section: string; views: string; deadClicks: string; rageClicks: string; dwellMs: string }>(
        `SELECT section_id AS section, countIf(event_name = 'section_view') AS views,
                countIf(event_name = 'dead_click') AS "deadClicks", countIf(event_name = 'rage_click') AS "rageClicks",
                sum(dwell_ms) AS "dwellMs"
         FROM events WHERE tenant_id = {tenantId:UUID} AND site_id = {siteId:UUID}
           AND event_time >= {from:DateTime64} AND event_time >= {previousFrom:DateTime64}
           AND event_time < {to:DateTime64} AND is_bot = 0 AND section_id != ''
         GROUP BY section_id ORDER BY views DESC`, params),
    ]);
    return buildReport(timeframe, range, availableFrom, events, sessions, sections.map(row => ({
      section: row.section, views: Number(row.views), deadClicks: Number(row.deadClicks), rageClicks: Number(row.rageClicks), dwellMs: Number(row.dwellMs),
    })));
  }

  async experimentImpact(tenantId: string, query: ExperimentImpactQuery) {
    const site = await this.requireSite(tenantId, query.siteId);
    const goal = await this.prisma.conversionGoal.findFirst({ where: { id: query.goalId, siteId: query.siteId } });
    if (!goal) throw new NotFoundException('Meta não encontrada neste site.');
    const range = reportRange(query.timeframe);
    const retentionFrom = this.ch.retentionDays === null ? 0 : Date.parse(range.to) - this.ch.retentionDays * 86_400_000;
    const availableFrom = new Date(Math.max(
      Math.ceil(goal.createdAt.getTime() / 86_400_000) * 86_400_000,
      Math.ceil(site.createdAt.getTime() / 86_400_000) * 86_400_000,
      retentionFrom,
    )).toISOString();
    const experiments = await this.prisma.experiment.findMany({
      where: {
        tenantId, siteId: query.siteId, status: { in: ['running', 'paused', 'completed', 'rolled_back'] },
        startedAt: { not: null, lt: new Date(range.to) },
        AND: [
          { OR: [{ primaryGoalId: query.goalId }, { primaryGoalId: null }] },
          { OR: [{ endedAt: null }, { endedAt: { gt: new Date(range.previousFrom) } }] },
        ],
      },
      select: { id: true, name: true, status: true, startedAt: true, endedAt: true, variants: { select: { id: true, isControl: true } } },
      orderBy: { startedAt: 'asc' },
    });
    const started = experiments.filter((experiment): experiment is typeof experiment & { startedAt: Date } => experiment.startedAt !== null);
    let rows: ImpactRow[] = [];
    if (started.length && availableFrom < range.to) {
      const sql = impactQuery(started, range, availableFrom);
      rows = await this.ch.query<ImpactRow>(sql.sql, { ...sql.params, tenantId, siteId: query.siteId, goal: goal.name });
    }
    return { goal: { id: goal.id, name: goal.name, isFavorite: goal.isFavorite }, ...buildExperimentImpact(query.timeframe, range, availableFrom, started, rows) };
  }

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

  async siteExperimentResults(tenantId: string, siteId: string) {
    await this.requireSite(tenantId, siteId);
    const experiments = await this.prisma.experiment.findMany({
      where: { tenantId, siteId }, orderBy: { createdAt: 'desc' },
      select: {
        id: true, siteId: true, name: true, status: true, type: true, insightId: true,
        startedAt: true, createdAt: true, endedAt: true, allocation: true, riskScore: true, resultSnapshot: true, evaluationPlan: true,
        primaryGoal: { select: { id: true, name: true } },
        variants: { select: { id: true, name: true, isControl: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!experiments.length) return [];
    const pending = experiments.filter(experiment => !storedReport(experiment.resultSnapshot));
    const query = pending.length ? experimentResultsQuery(pending) : null;
    const rows = query ? await this.ch.query<ResultRow>(query.sql, { ...query.params, tenantId, siteId }) : [];
    return buildExperimentResults(experiments, rows).map((result, index) => {
      const { variants: _variants, primaryGoal, resultSnapshot, evaluationPlan: _plan, ...experiment } = experiments[index]!;
      const snapshot = storedReport(resultSnapshot);
      const evidence = _plan ? evaluateEvidence(result.variants, _plan as unknown as EvaluationPlan, new Date(Date.now() - 86_400_000)) : { variants: [] };
      const current = { ...result, variants: result.variants.map(variant => ({ ...variant, decision: evidence.variants.find(item => item.variantId === variant.variantId)?.decision ?? 'collecting', significant: evidence.variants.some(item => item.variantId === variant.variantId && ['improvement', 'decline'].includes(item.decision)) })) };
      return { ...(snapshot ?? current), experiment: { ...experiment, allocation: Number(experiment.allocation) }, goal: snapshot ? snapshot.goal : primaryGoal };
    });
  }

  private async requireSite(tenantId: string, siteId: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFoundException('Site not found');
    if (site.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access');
    return site;
  }
}
