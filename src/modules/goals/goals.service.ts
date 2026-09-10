import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConversionGoal, ExperimentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.module';
import { newId } from '../../common/crypto/ids';
import {
  parseGoalMatcher,
  type CreateGoalDto,
  type GoalKind,
  type UpdateGoalDto,
} from './goals.dto';
import type { AuthUser } from '../../common/auth/auth.types';

/**
 * Experiments in a terminal state no longer block deletion of their primary
 * goal; the FK is `ON DELETE SET NULL`, so the historical link is simply
 * dropped. Active experiments must be finished/rolled back first.
 */
const TERMINAL_STATUSES: ExperimentStatus[] = ['completed', 'rejected', 'rolled_back'];

@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(user: AuthUser, siteId: string, dto: CreateGoalDto): Promise<ConversionGoal> {
    await this.requireSite(user.tenantId, siteId);
    await this.assertNameAvailable(siteId, dto.name);

    const goal = await this.prisma.conversionGoal.create({
      data: {
        id: newId(),
        siteId,
        name: dto.name,
        kind: dto.kind,
        matcher: dto.matcher as unknown as Prisma.InputJsonValue,
      },
    });

    await this.audit.log({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      action: 'goal.created',
      targetType: 'conversion_goal',
      targetId: goal.id,
      metadata: { siteId, name: goal.name, kind: goal.kind },
    });
    return goal;
  }

  async list(tenantId: string, siteId: string): Promise<ConversionGoal[]> {
    await this.requireSite(tenantId, siteId);
    return this.prisma.conversionGoal.findMany({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async get(tenantId: string, siteId: string, goalId: string): Promise<ConversionGoal> {
    await this.requireSite(tenantId, siteId);
    return this.requireGoal(siteId, goalId);
  }

  async update(
    user: AuthUser,
    siteId: string,
    goalId: string,
    dto: UpdateGoalDto,
  ): Promise<ConversionGoal> {
    await this.requireSite(user.tenantId, siteId);
    const goal = await this.requireGoal(siteId, goalId);

    const data: Prisma.ConversionGoalUpdateInput = {};
    if (dto.name !== undefined && dto.name !== goal.name) {
      await this.assertNameAvailable(siteId, dto.name, goalId);
      data.name = dto.name;
    }
    if (dto.matcher !== undefined) {
      let matcher: Record<string, unknown>;
      try {
        matcher = parseGoalMatcher(goal.kind as GoalKind, dto.matcher);
      } catch {
        throw new BadRequestException(`Invalid matcher for goal kind "${goal.kind}"`);
      }
      data.matcher = matcher as unknown as Prisma.InputJsonValue;
    }
    if (Object.keys(data).length === 0) return goal;

    const updated = await this.prisma.conversionGoal.update({ where: { id: goalId }, data });
    await this.audit.log({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      action: 'goal.updated',
      targetType: 'conversion_goal',
      targetId: goalId,
      metadata: { siteId, fields: Object.keys(data) },
    });
    return updated;
  }

  async remove(user: AuthUser, siteId: string, goalId: string): Promise<void> {
    await this.requireSite(user.tenantId, siteId);
    await this.requireGoal(siteId, goalId);

    const activeReferences = await this.prisma.experiment.count({
      where: { primaryGoalId: goalId, status: { notIn: TERMINAL_STATUSES } },
    });
    if (activeReferences > 0) {
      throw new ConflictException(
        'Goal is the primary goal of an active experiment; finish or roll back that experiment first',
      );
    }

    await this.prisma.conversionGoal.delete({ where: { id: goalId } });
    await this.audit.log({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      action: 'goal.deleted',
      targetType: 'conversion_goal',
      targetId: goalId,
      metadata: { siteId },
    });
  }

  /* ------------------------------- helpers -------------------------------- */

  private async assertNameAvailable(
    siteId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const existing = await this.prisma.conversionGoal.findUnique({
      where: { siteId_name: { siteId, name } },
    });
    if (existing && existing.id !== exceptId) {
      throw new ConflictException(`A goal named "${name}" already exists for this site`);
    }
  }

  private async requireGoal(siteId: string, goalId: string): Promise<ConversionGoal> {
    const goal = await this.prisma.conversionGoal.findFirst({ where: { id: goalId, siteId } });
    if (!goal) throw new NotFoundException('Goal not found');
    return goal;
  }

  private async requireSite(tenantId: string, siteId: string): Promise<void> {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFoundException('Site not found');
    if (site.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access');
  }
}
