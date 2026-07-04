import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma, SuggestionKind } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../../common/audit/audit.module';
import { newId } from '../../common/crypto/ids';
import { AiClient, type AiSuggestionOut } from './ai.client';
import type { AuthUser } from '../../common/auth/auth.types';

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly ai: AiClient,
    private readonly audit: AuditService,
  ) {}

  /** Run analysis for a site: gather metrics + guardrails, call AI, persist. */
  async analyze(user: AuthUser, siteId: string): Promise<{ count: number; score: number }> {
    const site = await this.requireSite(user.tenantId, siteId);
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 864e5).toISOString();

    const [overview, sections, guardrail, latestMap] = await Promise.all([
      this.analytics.overview(user.tenantId, siteId, fmt(from), fmt(now.toISOString())),
      this.analytics.sections(user.tenantId, siteId),
      this.prisma.brandGuardrail.findUnique({ where: { siteId } }),
      this.prisma.pageMap.findFirst({
        where: { siteId },
        orderBy: { capturedAt: 'desc' },
      }),
    ]);

    const result = await this.ai.analyze({
      siteId,
      pageMap: latestMap?.map ?? { nodes: [] },
      metrics: { overview, sections },
      guardrails: (guardrail?.rules as Record<string, unknown>) ?? {},
    });
    if (!result) throw new ServiceUnavailableException('AI service unavailable');

    await this.prisma.$transaction(
      result.suggestions.map((s) =>
        this.prisma.aiSuggestion.create({
          data: {
            id: newId(),
            tenantId: user.tenantId,
            siteId,
            kind: s.kind as SuggestionKind,
            payload: s as unknown as Prisma.InputJsonValue,
            model: result.model,
            expectedImpact: s.expectedImpact ?? null,
            riskLevel: s.riskLevel,
          },
        }),
      ),
    );

    await this.audit.log({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      action: 'ai.analyzed',
      targetType: 'site',
      targetId: siteId,
      metadata: { count: result.suggestions.length, score: result.score },
    });
    void site;
    return { count: result.suggestions.length, score: result.score };
  }

  async listSuggestions(tenantId: string, siteId: string): Promise<unknown[]> {
    await this.requireSite(tenantId, siteId);
    return this.prisma.aiSuggestion.findMany({
      where: { tenantId, siteId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /**
   * Convert a copy/headline/cta suggestion into an `ai_suggested` experiment
   * (control + variant). AI never auto-publishes — this only creates a draft
   * that still requires human approval before it can run.
   */
  async materialize(user: AuthUser, suggestionId: string): Promise<{ experimentId: string }> {
    const suggestion = await this.prisma.aiSuggestion.findUnique({
      where: { id: suggestionId },
    });
    if (!suggestion) throw new NotFoundException('Suggestion not found');
    if (suggestion.tenantId !== user.tenantId) throw new ForbiddenException('Cross-tenant access');

    const payload = suggestion.payload as unknown as AiSuggestionOut;
    if (!payload.selector || !payload.proposedValue) {
      throw new BadRequestException('Suggestion is not directly actionable');
    }

    const experimentId = newId();
    const type = payload.kind === 'cta' ? 'cta' : 'headline';
    await this.prisma.experiment.create({
      data: {
        id: experimentId,
        tenantId: user.tenantId,
        siteId: suggestion.siteId,
        name: payload.title.slice(0, 160),
        hypothesis: payload.detail.slice(0, 2000),
        type,
        status: 'ai_suggested',
        allocation: 0.5,
        targeting: {},
        riskScore: payload.riskLevel === 'high' ? 70 : payload.riskLevel === 'medium' ? 40 : 15,
        createdBy: user.userId,
        variants: {
          create: [
            { id: newId(), name: 'control', isControl: true, weight: 0.5 },
            {
              id: newId(),
              name: 'v1',
              isControl: false,
              weight: 0.5,
              changes: {
                create: [
                  {
                    id: newId(),
                    selector: payload.selector,
                    op: 'set_text',
                    originalValue: payload.originalValue ?? null,
                    proposedValue: payload.proposedValue,
                  },
                ],
              },
            },
          ],
        },
      },
    });

    await this.prisma.aiSuggestion.update({
      where: { id: suggestionId },
      data: { experimentId },
    });
    await this.audit.log({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      action: 'ai.materialized',
      targetType: 'experiment',
      targetId: experimentId,
      metadata: { suggestionId },
    });
    return { experimentId };
  }

  private async requireSite(tenantId: string, siteId: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFoundException('Site not found');
    if (site.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access');
    return site;
  }
}

function fmt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace('Z', '');
}
