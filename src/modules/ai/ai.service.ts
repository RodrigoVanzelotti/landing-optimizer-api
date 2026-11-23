import {
  BadRequestException,
  ConflictException,
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
import { insightKpis, resolveInsightEvidence } from './insight-evidence';
import { InsightExperimentProposalsSchema } from './experiment-proposals';
import type { GuardrailRules } from '../guardrails/guardrails.dto';

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly ai: AiClient,
    private readonly audit: AuditService,
  ) {}

  /** Run analysis for a site: gather metrics + guardrails, call AI, persist. */
  async analyze(
    user: AuthUser,
    siteId: string,
    requestId?: string,
  ): Promise<{ count: number; score: number }> {
    await this.requireSite(user.tenantId, siteId);

    const [report, guardrail, latestMap] = await Promise.all([
      this.analytics.report(user.tenantId, siteId, '30d'),
      this.prisma.brandGuardrail.findUnique({ where: { siteId } }),
      this.prisma.pageMap.findFirst({
        where: { siteId },
        orderBy: { capturedAt: 'desc' },
      }),
    ]);

    if (!report.current.pageViews) throw new BadRequestException('Ainda não há visualizações de página para fundamentar os insights. Aguarde a ingestão de dados.');
    const kpis = insightKpis(report);

    const result = await this.ai.analyze(
      {
        siteId,
        pageMap: latestMap?.map ?? { nodes: [] },
        metrics: {
          kpis,
          period: { ...report.range, ...report.coverage, timezone: report.timezone },
          overview: { ...report.current, conversionRate: report.current.conversions / report.current.pageViews },
          sections: report.sections,
        },
        guardrails: (guardrail?.rules as Record<string, unknown>) ?? {},
      },
      requestId,
    );
    if (!result) throw new ServiceUnavailableException('AI service unavailable');
    if (['stub-v1', 'synthetic-demo'].includes(result.model)) throw new ServiceUnavailableException('O serviço de IA retornou resultados de demonstração. Nenhum insight foi registrado.');

    const payloads = result.suggestions.map(s => {
      try { return { ...s, ...resolveInsightEvidence(s, report, kpis, latestMap) }; }
      catch { throw new ServiceUnavailableException('O serviço de IA retornou referências a KPIs ou elementos que não constam nos dados analisados.'); }
    });

    await this.prisma.$transaction(async tx => {
      await Promise.all(payloads.map((s) =>
        tx.aiSuggestion.create({
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
      ));

      await this.audit.log({
        tenantId: user.tenantId,
        actorUserId: user.userId,
        action: 'ai.analyzed',
        targetType: 'site',
        targetId: siteId,
        metadata: { count: result.suggestions.length, score: result.score },
      }, tx);
    });
    return { count: result.suggestions.length, score: result.score };
  }

  async listSuggestions(tenantId: string, siteId: string, insightId?: string): Promise<unknown[]> {
    await this.requireSite(tenantId, siteId);
    return this.prisma.aiSuggestion.findMany({
      where: { tenantId, siteId, ...(insightId ? { id: insightId } : {}), model: { notIn: ['stub-v1', 'synthetic-demo'] } },
      select: {
        id: true, tenantId: true, siteId: true, kind: true, payload: true, model: true,
        expectedImpact: true, riskLevel: true, createdAt: true, approvedAt: true, rejectedAt: true, experimentsReadyAt: true,
        experiments: { where: { tenantId, siteId }, select: { id: true, name: true, status: true }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** Approval authorizes preparation; the future IA workflow supplies results later. */
  async approve(user: AuthUser, suggestionId: string) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM ai_suggestion WHERE id = ${suggestionId} AND tenant_id = ${user.tenantId} FOR UPDATE`;
      const suggestion = await tx.aiSuggestion.findUnique({
        where: { id: suggestionId },
        include: { tenant: { select: { archivedAt: true } }, experiments: { select: { id: true, name: true, status: true }, orderBy: { createdAt: 'asc' } } },
      });
      if (!suggestion) throw new NotFoundException('Insight não encontrado.');
      if (suggestion.tenantId !== user.tenantId) throw new ForbiddenException('Este insight pertence a outro espaço de trabalho.');
      if (suggestion.tenant.archivedAt) throw new ForbiddenException('O espaço de trabalho está arquivado.');
      if (suggestion.rejectedAt) throw new ConflictException('Este insight já foi rejeitado. Atualize a lista de insights.');
      if (suggestion.approvedAt) return { approvedAt: suggestion.approvedAt, experimentsReadyAt: suggestion.experimentsReadyAt, experiments: suggestion.experiments };
      if (['stub-v1', 'synthetic-demo'].includes(suggestion.model)) throw new BadRequestException('Insights de demonstração não podem ser aprovados.');

      const approvedAt = new Date();
      const experiments = [...suggestion.experiments];
      for (const experiment of experiments) {
        if (!['draft', 'ai_suggested', 'pending_review'].includes(experiment.status)) continue;
        const pending = await tx.approval.updateMany({
          where: { experimentId: experiment.id, status: 'pending' },
          data: { status: 'approved', approverUserId: user.userId, decidedAt: approvedAt, reason: 'Aprovado com o insight de origem.' },
        });
        const changed = await tx.experiment.updateMany({ where: { id: experiment.id, tenantId: user.tenantId, status: experiment.status }, data: { status: 'approved' } });
        if (changed.count !== 1) throw new ConflictException('Um experimento foi alterado. Atualize os dados antes de aprovar o insight.');
        if (!pending.count) await tx.approval.create({ data: {
          id: newId(), experimentId: experiment.id, status: 'approved', approverUserId: user.userId,
          decidedAt: approvedAt, riskScore: suggestion.riskLevel === 'high' ? 70 : suggestion.riskLevel === 'medium' ? 40 : 15,
          reason: 'Aprovado com o insight de origem.',
        } });
        experiment.status = 'approved';
        await this.audit.log({ tenantId: user.tenantId, actorUserId: user.userId, action: 'experiment.approved', targetType: 'experiment', targetId: experiment.id, metadata: { suggestionId } }, tx);
      }
      const experimentsReadyAt = experiments.length ? approvedAt : null;
      await tx.aiSuggestion.update({ where: { id: suggestionId }, data: { approvedAt, approvedByUserId: user.userId, experimentsReadyAt } });
      await this.audit.log({
        tenantId: user.tenantId, actorUserId: user.userId, action: 'ai.approved',
        targetType: 'ai_suggestion', targetId: suggestionId,
        metadata: { siteId: suggestion.siteId, experimentIds: experiments.map(experiment => experiment.id) },
      }, tx);
      return { approvedAt, experimentsReadyAt, experiments };
    });
  }

  async reject(user: AuthUser, suggestionId: string) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM ai_suggestion WHERE id = ${suggestionId} AND tenant_id = ${user.tenantId} FOR UPDATE`;
      const suggestion = await tx.aiSuggestion.findUnique({
        where: { id: suggestionId }, include: { tenant: { select: { archivedAt: true } } },
      });
      if (!suggestion) throw new NotFoundException('Insight não encontrado.');
      if (suggestion.tenantId !== user.tenantId) throw new ForbiddenException('Este insight pertence a outro espaço de trabalho.');
      if (suggestion.tenant.archivedAt) throw new ForbiddenException('O espaço de trabalho está arquivado.');
      if (suggestion.rejectedAt) return { rejectedAt: suggestion.rejectedAt };
      if (suggestion.approvedAt) throw new ConflictException('Este insight já foi aprovado. Acompanhe seus experimentos na aba Experimentos.');
      if (['stub-v1', 'synthetic-demo'].includes(suggestion.model)) throw new BadRequestException('Insights de demonstração não podem ser rejeitados.');
      const rejectedAt = new Date();
      await tx.aiSuggestion.update({ where: { id: suggestionId }, data: { rejectedAt, rejectedByUserId: user.userId } });
      await this.audit.log({
        tenantId: user.tenantId, actorUserId: user.userId, action: 'ai.rejected',
        targetType: 'ai_suggestion', targetId: suggestionId, metadata: { siteId: suggestion.siteId },
      }, tx);
      return { rejectedAt };
    });
  }

  /** Internal API integration point; does not invoke or schedule the IA module. */
  async completeExperiments(tenantId: string, suggestionId: string, rawProposals: unknown) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM ai_suggestion WHERE id = ${suggestionId} AND tenant_id = ${tenantId} FOR UPDATE`;
      const suggestion = await tx.aiSuggestion.findUnique({
        where: { id: suggestionId },
        include: { tenant: { select: { archivedAt: true } }, experiments: { select: { id: true, name: true, status: true }, orderBy: { createdAt: 'asc' } } },
      });
      if (!suggestion) throw new NotFoundException('Insight não encontrado.');
      if (suggestion.tenantId !== tenantId) throw new ForbiddenException('Este insight pertence a outro espaço de trabalho.');
      if (suggestion.tenant.archivedAt) throw new ForbiddenException('O espaço de trabalho está arquivado.');
      if (suggestion.rejectedAt || !suggestion.approvedAt) throw new ConflictException('O insight precisa estar aprovado antes de gerar experimentos.');
      if (suggestion.experimentsReadyAt) return { experimentsReadyAt: suggestion.experimentsReadyAt, experiments: suggestion.experiments };
      if (!suggestion.approvedByUserId) throw new ConflictException('A aprovação do insight não possui um responsável registrado.');
      const parsed = InsightExperimentProposalsSchema.safeParse(rawProposals);
      if (!parsed.success || !parsed.data.length) throw new BadRequestException('A preparação precisa fornecer propostas válidas de experimento.');

      const guardrail = await tx.brandGuardrail.findUnique({ where: { siteId: suggestion.siteId } });
      const rules = (guardrail?.rules ?? {}) as GuardrailRules;
      for (const proposal of parsed.data) {
        if ((rules.maxLength && proposal.proposedValue.length > rules.maxLength) ||
          rules.bannedWords?.some(word => proposal.proposedValue.toLowerCase().includes(word.toLowerCase()))) {
          throw new BadRequestException('Uma proposta não atende às diretrizes atuais da marca.');
        }
      }

      const payload = suggestion.payload as unknown as AiSuggestionOut;
      const experiments = [...suggestion.experiments];
      const riskScore = suggestion.riskLevel === 'high' ? 70 : suggestion.riskLevel === 'medium' ? 40 : 15;
      for (const [index, proposal] of parsed.data.entries()) {
        const suffix = parsed.data.length > 1 ? ` · ${index + 1}` : '';
        const title = payload.title || 'Experimento do insight';
        const experiment = await tx.experiment.create({
          data: {
            id: newId(), insightId: suggestionId, tenantId, siteId: suggestion.siteId,
            name: proposal.name ?? `${title.slice(0, 160 - suffix.length)}${suffix}`,
            hypothesis: (payload.detail ?? '').slice(0, 2000),
            type: proposal.type ?? (payload.kind === 'cta' ? 'cta' : payload.kind === 'headline' ? 'headline' : 'copy'),
            status: 'approved', allocation: 0.5, targeting: {}, riskScore, createdBy: suggestion.approvedByUserId,
            variants: { create: [
              { id: newId(), name: 'Controle', isControl: true, weight: 0.5 },
              { id: newId(), name: 'Proposta', isControl: false, weight: 0.5,
                changes: { create: [{
                  id: newId(), selector: proposal.selector, op: 'set_text',
                  originalValue: proposal.originalValue ?? null, proposedValue: proposal.proposedValue,
                }] },
              },
            ] },
            approvals: { create: {
              id: newId(), status: 'approved', riskScore, approverUserId: suggestion.approvedByUserId,
              decidedAt: suggestion.approvedAt, reason: 'Aprovação herdada do insight de origem.',
            } },
          },
          select: { id: true, name: true, status: true },
        });
        experiments.push(experiment);
        await this.audit.log({
          tenantId, actorUserId: suggestion.approvedByUserId, action: 'ai.materialized',
          targetType: 'experiment', targetId: experiment.id, metadata: { suggestionId, automated: true },
        }, tx);
      }
      const experimentsReadyAt = new Date();
      await tx.aiSuggestion.update({ where: { id: suggestionId }, data: { experimentsReadyAt } });
      await this.audit.log({
        tenantId, actorUserId: suggestion.approvedByUserId, action: 'ai.experiments_ready',
        targetType: 'ai_suggestion', targetId: suggestionId, metadata: { experimentIds: experiments.map(experiment => experiment.id) },
      }, tx);
      return { experimentsReadyAt, experiments };
    });
  }

  private async requireSite(tenantId: string, siteId: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFoundException('Site not found');
    if (site.tenantId !== tenantId) throw new ForbiddenException('Cross-tenant access');
    return site;
  }
}
