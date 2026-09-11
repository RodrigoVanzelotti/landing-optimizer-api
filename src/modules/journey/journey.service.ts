import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClickHouseService } from '../analytics/clickhouse/clickhouse.service';

/**
 * Activation journey: the ordered set of milestones a new operator walks from
 * "created a site" to "first significant experiment result". Every state is
 * computed from real stored data (never a stored flag), so an unlock can never
 * lie, and progress is always current. The dashboard renders this as the
 * getting-started checklist and as progress-gated feature panels.
 *
 * Thresholds are product-tunable in one place below. They are honest gates:
 * each feature genuinely needs that much data to be useful (e.g. the results
 * target matches the significance test's 30-exposures-per-arm floor).
 */

export const JOURNEY_TARGETS = {
  /** page views before the analytics pages are considered meaningful. */
  trafficPageViews: 100,
  /** element-anchored events before the heatmap reads as a heatmap. */
  heatmapElementEvents: 200,
  /** page views before AI analysis has enough signal to be worth running. */
  aiPageViews: 500,
  /** total exposures before significance is possible (30 per arm, see stats.ts). */
  resultExposures: 60,
} as const;

export type MilestoneId =
  | 'site_created'
  | 'snippet_installed'
  | 'traffic'
  | 'goal_defined'
  | 'conversion_tracked'
  | 'snapshot_captured'
  | 'heatmap_ready'
  | 'ai_ready'
  | 'experiment_created'
  | 'experiment_live'
  | 'results_ready';

export interface Milestone {
  id: MilestoneId;
  done: boolean;
  /** present when the milestone is a measurable accumulation. */
  current?: number;
  target?: number;
}

export interface JourneyResult {
  siteId: string;
  firstEventAt: string | null;
  lastEventAt: string | null;
  completed: number;
  total: number;
  milestones: Milestone[];
}

interface EventStats {
  events: string;
  page_views: string;
  conversions: string;
  element_events: string;
  exposures: string;
  first_event: string;
  last_event: string;
}

@Injectable()
export class JourneyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ch: ClickHouseService,
  ) {}

  async get(tenantId: string, siteId: string): Promise<JourneyResult> {
    await this.requireSite(tenantId, siteId);

    const [stats, goals, snapshots, pageMaps, experiments, startedExperiments] =
      await Promise.all([
        this.eventStats(tenantId, siteId),
        this.prisma.conversionGoal.count({ where: { siteId } }),
        this.prisma.pageSnapshot.count({ where: { siteId } }),
        this.prisma.pageMap.count({ where: { siteId } }),
        this.prisma.experiment.count({ where: { siteId } }),
        this.prisma.experiment.count({ where: { siteId, startedAt: { not: null } } }),
      ]);

    const events = Number(stats?.events ?? 0);
    const pageViews = Number(stats?.page_views ?? 0);
    const conversions = Number(stats?.conversions ?? 0);
    const elementEvents = Number(stats?.element_events ?? 0);
    const exposures = Number(stats?.exposures ?? 0);
    const t = JOURNEY_TARGETS;

    const milestones: Milestone[] = [
      { id: 'site_created', done: true },
      { id: 'snippet_installed', done: events > 0 },
      {
        id: 'traffic',
        done: pageViews >= t.trafficPageViews,
        current: Math.min(pageViews, t.trafficPageViews),
        target: t.trafficPageViews,
      },
      { id: 'goal_defined', done: goals > 0 },
      { id: 'conversion_tracked', done: conversions > 0 },
      { id: 'snapshot_captured', done: snapshots > 0 },
      {
        id: 'heatmap_ready',
        done: snapshots > 0 && elementEvents >= t.heatmapElementEvents,
        current: Math.min(elementEvents, t.heatmapElementEvents),
        target: t.heatmapElementEvents,
      },
      {
        id: 'ai_ready',
        done: pageMaps > 0 && pageViews >= t.aiPageViews,
        current: Math.min(pageViews, t.aiPageViews),
        target: t.aiPageViews,
      },
      { id: 'experiment_created', done: experiments > 0 },
      { id: 'experiment_live', done: startedExperiments > 0 },
      {
        id: 'results_ready',
        done: exposures >= t.resultExposures,
        current: Math.min(exposures, t.resultExposures),
        target: t.resultExposures,
      },
    ];

    return {
      siteId,
      firstEventAt: events > 0 ? toIso(stats?.first_event) : null,
      lastEventAt: events > 0 ? toIso(stats?.last_event) : null,
      completed: milestones.filter((m) => m.done).length,
      total: milestones.length,
      milestones,
    };
  }

  private async eventStats(tenantId: string, siteId: string): Promise<EventStats | undefined> {
    const rows = await this.ch.query<EventStats>(
      `SELECT count()                                  AS events,
              countIf(event_name = 'page_view')        AS page_views,
              countIf(event_name = 'conversion')       AS conversions,
              countIf(selector != '')                  AS element_events,
              countIf(event_name = 'exposure')         AS exposures,
              toString(min(event_time))                AS first_event,
              toString(max(event_time))                AS last_event
       FROM events
       WHERE tenant_id = {tenantId:UUID} AND site_id = {siteId:UUID}`,
      { tenantId, siteId },
    );
    return rows[0];
  }

  private async requireSite(tenantId: string, siteId: string): Promise<void> {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFoundException('Site not found');
    if (site.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access');
  }
}

/** ClickHouse DateTime64 text ('YYYY-MM-DD HH:mm:ss.SSS') → ISO 8601 UTC. */
function toIso(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
