import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Experiment, ExperimentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.module';
import { SiteConfigService } from '../sites/site-config.service';
import { newId } from '../../common/crypto/ids';
import {
  canTransition,
  EDITABLE_STATUSES,
} from './experiment-state-machine';
import type {
  ApproveDto,
  CompleteDto,
  CreateExperimentDto,
  RejectDto,
  ScheduleDto,
  UpdateExperimentDto,
} from './experiments.dto';
import type { AuthUser } from '../../common/auth/auth.types';

const HIGH_RISK_OPS = new Set(['section_order', 'section_visibility', 'set_html_safe', 'hide']);

@Injectable()
export class ExperimentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteConfig: SiteConfigService,
    private readonly audit: AuditService,
  ) {}

  async create(user: AuthUser, dto: CreateExperimentDto): Promise<Experiment> {
    await this.requireSite(user.tenantId, dto.siteId);
    const id = newId();
    const riskScore = computeRiskScore(dto);

    const experiment = await this.prisma.experiment.create({
      data: {
        id,
        tenantId: user.tenantId,
        siteId: dto.siteId,
        name: dto.name,
        hypothesis: dto.hypothesis ?? null,
        type: dto.type,
        status: 'draft',
        allocation: dto.allocation,
        targeting: (dto.targeting ?? {}) as Prisma.InputJsonValue,
        primaryGoalId: dto.primaryGoalId ?? null,
        riskScore,
        createdBy: user.userId,
        variants: {
          create: dto.variants.map((v) => ({
            id: newId(),
            name: v.name,
            isControl: v.isControl,
            weight: v.weight,
            changes: {
              create: v.changes.map((c) => ({
                id: newId(),
                selector: c.selector,
                op: c.op,
                originalValue: c.originalValue ?? null,
                proposedValue: c.proposedValue ?? null,
                attrName: c.attrName ?? null,
              })),
            },
          })),
        },
      },
    });

    await this.audit.log({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      action: 'experiment.created',
      targetType: 'experiment',
      targetId: id,
      metadata: { name: dto.name, type: dto.type, riskScore },
    });
    return experiment;
  }

  list(tenantId: string, filter: { siteId?: string; status?: ExperimentStatus }) {
    return this.prisma.experiment.findMany({
      where: {
        tenantId,
        ...(filter.siteId ? { siteId: filter.siteId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { variants: true },
    });
  }

  async get(tenantId: string, id: string) {
    const experiment = await this.prisma.experiment.findUnique({
      where: { id },
      include: {
        variants: { include: { changes: true } },
        approvals: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!experiment) throw new NotFoundException('Experiment not found');
    if (experiment.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access');
    return experiment;
  }

  async update(tenantId: string, id: string, dto: UpdateExperimentDto): Promise<Experiment> {
    const experiment = await this.requireExperiment(tenantId, id);
    if (!EDITABLE_STATUSES.includes(experiment.status)) {
      throw new ConflictException(`Cannot edit experiment in status ${experiment.status}`);
    }
    const data: Prisma.ExperimentUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.hypothesis !== undefined) data.hypothesis = dto.hypothesis;
    if (dto.allocation !== undefined) data.allocation = dto.allocation;
    if (dto.targeting !== undefined) data.targeting = dto.targeting as Prisma.InputJsonValue;
    return this.prisma.experiment.update({ where: { id }, data });
  }

  /* --------------------------- state transitions -------------------------- */

  async submit(user: AuthUser, id: string): Promise<Experiment> {
    const experiment = await this.requireExperiment(user.tenantId, id);
    this.assertTransition(experiment.status, 'pending_review');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.approval.create({
        data: {
          id: newId(),
          experimentId: id,
          status: 'pending',
          riskScore: experiment.riskScore,
        },
      });
      return tx.experiment.update({ where: { id }, data: { status: 'pending_review' } });
    });
    await this.record(user, id, 'experiment.submitted');
    return updated;
  }

  async approve(user: AuthUser, id: string, dto: ApproveDto): Promise<Experiment> {
    const experiment = await this.requireExperiment(user.tenantId, id);
    this.assertTransition(experiment.status, 'approved');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.approval.updateMany({
        where: { experimentId: id, status: 'pending' },
        data: {
          status: 'approved',
          reason: dto.reason ?? null,
          checklist: (dto.checklist ?? {}) as Prisma.InputJsonValue,
          screenshotUrl: dto.screenshotUrl ?? null,
          approverUserId: user.userId,
          decidedAt: new Date(),
        },
      });
      return tx.experiment.update({ where: { id }, data: { status: 'approved' } });
    });
    await this.record(user, id, 'experiment.approved', { reason: dto.reason });
    return updated;
  }

  async reject(user: AuthUser, id: string, dto: RejectDto): Promise<Experiment> {
    const experiment = await this.requireExperiment(user.tenantId, id);
    this.assertTransition(experiment.status, 'rejected');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.approval.updateMany({
        where: { experimentId: id, status: 'pending' },
        data: {
          status: 'rejected',
          reason: dto.reason,
          approverUserId: user.userId,
          decidedAt: new Date(),
        },
      });
      return tx.experiment.update({ where: { id }, data: { status: 'rejected' } });
    });
    await this.record(user, id, 'experiment.rejected', { reason: dto.reason });
    return updated;
  }

  async schedule(user: AuthUser, id: string, dto: ScheduleDto): Promise<Experiment> {
    const experiment = await this.requireExperiment(user.tenantId, id);
    this.assertTransition(experiment.status, 'scheduled');
    const updated = await this.prisma.experiment.update({
      where: { id },
      data: { status: 'scheduled', startedAt: new Date(dto.startAt) },
    });
    await this.record(user, id, 'experiment.scheduled', { startAt: dto.startAt });
    return updated;
  }

  async start(user: AuthUser, id: string): Promise<Experiment> {
    const experiment = await this.requireExperiment(user.tenantId, id);
    this.assertTransition(experiment.status, 'running');
    const updated = await this.prisma.experiment.update({
      where: { id },
      data: { status: 'running', startedAt: experiment.startedAt ?? new Date() },
    });
    await this.siteConfig.publish(experiment.siteId);
    await this.record(user, id, 'experiment.started');
    return updated;
  }

  async pause(user: AuthUser, id: string): Promise<Experiment> {
    const experiment = await this.requireExperiment(user.tenantId, id);
    this.assertTransition(experiment.status, 'paused');
    const updated = await this.prisma.experiment.update({
      where: { id },
      data: { status: 'paused' },
    });
    await this.siteConfig.publish(experiment.siteId);
    await this.record(user, id, 'experiment.paused');
    return updated;
  }

  async complete(user: AuthUser, id: string, dto: CompleteDto): Promise<Experiment> {
    const experiment = await this.requireExperiment(user.tenantId, id);
    this.assertTransition(experiment.status, 'completed');
    const updated = await this.prisma.experiment.update({
      where: { id },
      data: {
        status: 'completed',
        endedAt: new Date(),
        winnerVariantId: dto.winnerVariantId ?? null,
      },
    });
    await this.siteConfig.publish(experiment.siteId);
    await this.record(user, id, 'experiment.completed', {
      winnerVariantId: dto.winnerVariantId,
    });
    return updated;
  }

  async rollback(user: AuthUser, id: string): Promise<Experiment> {
    const experiment = await this.requireExperiment(user.tenantId, id);
    this.assertTransition(experiment.status, 'rolled_back');
    const updated = await this.prisma.experiment.update({
      where: { id },
      data: { status: 'rolled_back', endedAt: new Date() },
    });
    await this.siteConfig.publish(experiment.siteId);
    await this.record(user, id, 'experiment.rolled_back');
    return updated;
  }

  /** Emergency kill switch: immediately pause and republish (drops it live). */
  async kill(user: AuthUser, id: string): Promise<Experiment> {
    const experiment = await this.requireExperiment(user.tenantId, id);
    if (!['running', 'scheduled', 'paused'].includes(experiment.status)) {
      throw new ConflictException(`Cannot kill experiment in status ${experiment.status}`);
    }
    const updated = await this.prisma.experiment.update({
      where: { id },
      data: { status: 'paused' },
    });
    await this.siteConfig.publish(experiment.siteId);
    await this.record(user, id, 'experiment.killed');
    return updated;
  }

  /* ------------------------------- helpers -------------------------------- */

  private assertTransition(from: ExperimentStatus, to: ExperimentStatus): void {
    if (!canTransition(from, to)) {
      throw new ConflictException({
        message: `Invalid transition ${from} -> ${to}`,
        errors: { status: [`invalid_state_transition`] },
      });
    }
  }

  private async requireExperiment(tenantId: string, id: string): Promise<Experiment> {
    const experiment = await this.prisma.experiment.findUnique({ where: { id } });
    if (!experiment) throw new NotFoundException('Experiment not found');
    if (experiment.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access');
    return experiment;
  }

  private async requireSite(tenantId: string, siteId: string): Promise<void> {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new BadRequestException('Unknown site');
    if (site.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access');
  }

  private async record(
    user: AuthUser,
    id: string,
    action: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.audit.log({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      action,
      targetType: 'experiment',
      targetId: id,
      metadata,
    });
  }
}

/** Simple heuristic risk score (0..100) from the proposed changes. */
export function computeRiskScore(dto: CreateExperimentDto): number {
  let score = 10;
  for (const v of dto.variants) {
    for (const c of v.changes) {
      score += HIGH_RISK_OPS.has(c.op) ? 20 : 5;
    }
  }
  if (dto.allocation > 0.5) score += 10;
  return Math.min(100, score);
}
