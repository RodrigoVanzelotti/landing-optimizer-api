import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { writeAudit } from '../../common/audit/audit.module';
import { Logger } from '../../common/logging/logger';
import { ExperimentReportService } from '../analytics/experiment-report.service';
import { SiteConfigService } from '../sites/site-config.service';
import { storedReport } from '../analytics/experiment-report';

const logger = Logger('ExperimentEvaluator');
@Injectable()
export class ExperimentEvaluator implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active = false;
  constructor(private readonly prisma: PrismaService, private readonly reports: ExperimentReportService, private readonly configs: SiteConfigService) {}

  onApplicationBootstrap() {
    // shortcut: evaluates on active API instances; use the central scheduler if instances scale to zero.
    this.timer = setInterval(() => { void this.reconcile(); }, 60_000);
    this.timer.unref();
    void this.reconcile();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async reconcile() {
    if (this.active) return;
    this.active = true;
    try {
      const experiments = await this.prisma.experiment.findMany({ where: { OR: [{ status: 'running' }, { status: 'completed', resultSnapshot: { equals: Prisma.DbNull } }] }, orderBy: { createdAt: 'asc' } });
      for (let experiment of experiments) {
        try {
          if (!experiment.evaluationPlan) {
            const start = experiment.startedAt ?? new Date();
            let plan = await this.reports.planFor(experiment, start);
            // A site without prior history first collects a pilot, excluded from subsequent evidence.
            if (!plan && experiment.status === 'running') plan = await this.reports.planFor(experiment, new Date());
            if (plan) {
              experiment = await this.prisma.experiment.update({ where: { id: experiment.id, status: experiment.status, updatedAt: experiment.updatedAt }, data: { evaluationPlan: plan as unknown as Prisma.InputJsonValue } });
            }
          }
          const report = await this.reports.report(experiment.tenantId, experiment.id);
          const finalized = Boolean(storedReport(report));
          if (!finalized && experiment.status !== 'completed') continue;
          const changed = await this.prisma.$transaction(async tx => {
            const update = await tx.experiment.updateMany({ where: { id: experiment.id, status: experiment.status, updatedAt: experiment.updatedAt }, data: finalized ? {
              status: 'completed', endedAt: new Date(report.recordedAt), resultSnapshot: report as unknown as Prisma.InputJsonValue,
            } : { status: 'paused', endedAt: null, winnerVariantId: null } });
            if (!update.count) return false;
            await tx.site.update({ where: { id: experiment.siteId }, data: { configVersion: { increment: 1 } } });
            await writeAudit(tx, { tenantId: experiment.tenantId, action: finalized ? 'experiment.completed' : 'experiment.result_reopened', targetType: 'experiment', targetId: experiment.id,
              metadata: { automatic: true, previousStatus: experiment.status, previousEndedAt: experiment.endedAt?.toISOString() ?? null, previousWinnerVariantId: experiment.winnerVariantId, relativeEffect: .1, conversionWindowHours: 24 } });
            return true;
          });
          if (changed) await this.configs.publish(experiment.siteId);
        } catch {
          logger.warn('experiment_evaluation_failed', { experimentId: experiment.id });
        }
      }
    } catch { logger.warn('experiment_evaluation_unavailable'); }
    finally { this.active = false; }
  }
}
