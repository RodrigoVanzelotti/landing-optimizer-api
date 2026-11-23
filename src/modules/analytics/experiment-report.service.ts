import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Experiment } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClickHouseService } from './clickhouse/clickhouse.service';
import { buildTimeline, CONVERSION_WINDOW_MS, storedReport, timelineQuery, type ExperimentReport, type TimelineRow } from './experiment-report';
import { evaluateEvidence, evaluationPlan, type EvaluationPlan } from '../experiments/experiment-evidence';

const stamp = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', '');
@Injectable()
export class ExperimentReportService {
  constructor(private readonly prisma: PrismaService, private readonly ch: ClickHouseService) {}

  async planFor(experiment: Pick<Experiment, 'id' | 'siteId' | 'tenantId' | 'primaryGoalId' | 'allocation'>, from: Date): Promise<EvaluationPlan | null> {
    const variants = await this.prisma.variant.findMany({ where: { experimentId: experiment.id }, select: { weight: true } });
    const goal = experiment.primaryGoalId ? await this.prisma.conversionGoal.findFirst({ where: { id: experiment.primaryGoalId, siteId: experiment.siteId } }) : null;
    const rows = await this.ch.query<{ visits: string | number; conversions: string | number }>(`WITH sessions AS (
      SELECT session_id, max(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) AS visited,
        max(CASE WHEN event_name = 'conversion' AND ({goal:String} = '' OR goal = {goal:String}) THEN 1 ELSE 0 END) AS converted
      FROM events WHERE tenant_id = {tenantId:UUID} AND site_id = {siteId:UUID} AND is_bot = 0 AND session_id != ''
        AND event_time >= {from:DateTime64} AND event_time < {to:DateTime64} GROUP BY session_id
    ) SELECT sum(visited) AS visits, sum(CASE WHEN visited = 1 THEN converted ELSE 0 END) AS conversions FROM sessions`, {
      tenantId: experiment.tenantId, siteId: experiment.siteId, goal: goal?.name ?? '',
      from: stamp(new Date(from.getTime() - 30 * 86_400_000)), to: stamp(from),
    });
    return evaluationPlan(Number(rows[0]?.visits ?? 0), Number(rows[0]?.conversions ?? 0), Number(experiment.allocation), variants.map(variant => Number(variant.weight)), from);
  }

  async report(tenantId: string, id: string, now = new Date()): Promise<ExperimentReport> {
    const experiment = await this.prisma.experiment.findUnique({ where: { id }, include: { variants: { orderBy: { createdAt: 'asc' } }, primaryGoal: true } });
    if (!experiment) throw new NotFoundException('Experiment not found');
    if (experiment.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access');
    const snapshot = storedReport(experiment.resultSnapshot);
    if (snapshot && snapshot.experimentId === id && snapshot.experiment.siteId === experiment.siteId) return { ...snapshot, experiment: { ...snapshot.experiment, status: experiment.status } };
    const plan = experiment.evaluationPlan as unknown as EvaluationPlan | null;
    const from = new Date(plan?.analysisFrom ?? experiment.startedAt ?? now);
    const to = experiment.endedAt && experiment.endedAt < now ? experiment.endedAt : now;
    const cutoff = new Date(to.getTime() - CONVERSION_WINDOW_MS);
    const available = this.ch.retentionDays ? new Date(now.getTime() - this.ch.retentionDays * 86_400_000) : from;
    const coverageComplete = available <= from;
    const queryFrom = available > from ? available : from;
    const rows = cutoff > queryFrom ? await this.ch.query<TimelineRow>(timelineQuery(), { tenantId, siteId: experiment.siteId, experimentId: id, started: stamp(experiment.startedAt ?? queryFrom), from: stamp(queryFrom), cutoff: stamp(cutoff), to: stamp(to), goal: experiment.primaryGoal?.name ?? '' }) : [];
    const timeline = buildTimeline(experiment.variants, rows, queryFrom, cutoff);
    const evidence = plan ? evaluateEvidence(timeline.variants, plan, cutoff) : { conclusive: false, variants: [] };
    return { version: 1, experimentId: id, experiment: { id, siteId: experiment.siteId, name: experiment.name, status: experiment.status },
      goal: experiment.primaryGoal ? { id: experiment.primaryGoal.id, name: experiment.primaryGoal.name } : null,
      ...timeline, variants: timeline.variants.map(variant => ({ ...variant, decision: evidence.variants.find(item => item.variantId === variant.variantId)?.decision ?? 'collecting', significant: evidence.variants.some(item => item.variantId === variant.variantId && ['improvement', 'decline'].includes(item.decision)) })), plan, evidence: evidence.variants, conclusive: coverageComplete && evidence.conclusive,
      coverageComplete, recordedAt: to.toISOString(), conversionWindowHours: 24 };
  }
}
