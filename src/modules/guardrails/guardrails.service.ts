import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.module';
import { newId } from '../../common/crypto/ids';
import { normalizeGuardrailRules, type GuardrailRules } from './guardrails.dto';
import type { AuthUser } from '../../common/auth/auth.types';

export interface GuardrailView {
  siteId: string;
  rules: GuardrailRules;
  updatedAt: Date | null;
}

@Injectable()
export class GuardrailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(tenantId: string, siteId: string): Promise<GuardrailView> {
    await this.requireSite(tenantId, siteId);
    const guardrail = await this.prisma.brandGuardrail.findUnique({ where: { siteId } });
    return {
      siteId,
      rules: (guardrail?.rules as GuardrailRules | undefined) ?? {},
      updatedAt: guardrail?.updatedAt ?? null,
    };
  }

  async put(user: AuthUser, siteId: string, rules: GuardrailRules): Promise<GuardrailView> {
    await this.requireSite(user.tenantId, siteId);
    const clean = normalizeGuardrailRules(rules);

    const saved = await this.prisma.brandGuardrail.upsert({
      where: { siteId },
      create: { id: newId(), siteId, rules: clean as unknown as Prisma.InputJsonValue },
      update: { rules: clean as unknown as Prisma.InputJsonValue },
    });

    await this.audit.log({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      action: 'guardrail.updated',
      targetType: 'brand_guardrail',
      targetId: siteId,
      metadata: {
        bannedWords: clean.bannedWords?.length ?? 0,
        maxLength: clean.maxLength ?? null,
        mustKeepClaims: clean.mustKeepClaims?.length ?? 0,
      },
    });

    return { siteId, rules: saved.rules as GuardrailRules, updatedAt: saved.updatedAt };
  }

  private async requireSite(tenantId: string, siteId: string): Promise<void> {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFoundException('Site not found');
    if (site.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access');
  }
}
