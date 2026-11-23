import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Module, type ExecutionContext } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHttpAdapter } from '../src/http-adapter';
import { RolesGuard } from '../src/common/auth/roles.guard';
import { AiController } from '../src/modules/ai/ai.controller';
import { AiService } from '../src/modules/ai/ai.service';
import { ExperimentsService } from '../src/modules/experiments/experiments.service';
import { ExperimentQuerySchema } from '../src/modules/experiments/experiments.dto';
import { ApprovalsService, ApprovalQuerySchema } from '../src/modules/approvals/approvals.module';
import { InsightExperimentProposalsSchema } from '../src/modules/ai/experiment-proposals';

const user = { userId: 'user', tenantId: 'tenant', role: 'editor', email: 'editor@example.com' } as const;
const proposals = [
  { name: 'Título', type: 'headline', selector: '#title', proposedValue: 'Valor claro' },
  { name: 'Chamada', type: 'cta', selector: '#cta', proposedValue: 'Conhecer planos' },
];
type LinkedExperiment = { id: string; name: string; status: string };

function setup(payload: Record<string, unknown> = { title: 'Insight', detail: 'Hipótese observada', experimentProposals: proposals }) {
  const insight = {
    id: 'insight', tenantId: 'tenant', siteId: 'site', model: 'production', riskLevel: 'low',
    tenant: { archivedAt: null as Date | null },
    approvedAt: null as Date | null, approvedByUserId: null as string | null, experimentsReadyAt: null as Date | null,
    payload, experiments: [] as LinkedExperiment[],
  };
  type Update = Partial<Pick<typeof insight, 'approvedAt' | 'approvedByUserId' | 'experimentsReadyAt'>>;
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'insight' }]),
    aiSuggestion: {
      findUnique: vi.fn(async () => structuredClone(insight)),
      update: vi.fn(async ({ data }: { data: Update }) => { Object.assign(insight, data); return structuredClone(insight); }),
    },
    experiment: {
      create: vi.fn(async ({ data }: { data: { id: string; name: string; status: string } }) => {
        const experiment = { id: data.id, name: data.name, status: data.status };
        insight.experiments.push(experiment); return experiment;
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    approval: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn() },
    brandGuardrail: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  const db = { ...tx, $transaction: async <T>(fn: (client: typeof tx) => Promise<T>): Promise<T> => {
    const previous = structuredClone(insight);
    try { return await fn(tx); } catch (error) { Object.assign(insight, previous); throw error; }
  } };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  return { insight, tx, audit, service: new AiService(db as never, {} as never, {} as never, audit as never) };
}

describe('insight approval and deferred preparation', () => {
  it('records approval without generating experiments or performing analysis', async () => {
    const { insight, tx, audit, service } = setup();
    expect(await service.approve(user, 'insight')).toMatchObject({ approvedAt: expect.any(Date), experimentsReadyAt: null, experiments: [] });
    expect(insight.approvedByUserId).toBe('user');
    expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['insight', 'tenant']);
    expect(tx.experiment.create).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'ai.approved', actorUserId: 'user', targetId: 'insight' }), tx);
  });

  it('records approval even without ready-made proposals and never creates placeholders', async () => {
    const { service, tx } = setup({ title: 'Observação', kpiKeys: ['sessions'] });
    expect(await service.approve(user, 'insight')).toMatchObject({ approvedAt: expect.any(Date), experimentsReadyAt: null, experiments: [] });
    expect(tx.experiment.create).not.toHaveBeenCalled();
  });

  it('requires approval before accepting preparation results', async () => {
    const { service, tx } = setup();
    await expect(service.completeExperiments('tenant', 'insight', proposals)).rejects.toMatchObject({ status: 409 });
    expect(tx.experiment.create).not.toHaveBeenCalled();
    expect(tx.aiSuggestion.update).not.toHaveBeenCalled();
  });

  it('accepts multiple real results as already-approved experiments with inherited approval records', async () => {
    const { insight, service, tx, audit } = setup();
    await service.approve(user, 'insight');
    const result = await service.completeExperiments('tenant', 'insight', proposals);
    expect(result.experimentsReadyAt).toBeInstanceOf(Date);
    expect(result.experiments).toHaveLength(2);
    expect(tx.experiment.create.mock.calls.map(call => call[0].data)).toMatchObject([
      { name: 'Título', type: 'headline', insightId: 'insight', siteId: 'site', tenantId: 'tenant', status: 'approved', approvals: { create: { status: 'approved', approverUserId: 'user', decidedAt: insight.approvedAt } } },
      { name: 'Chamada', type: 'cta', insightId: 'insight', siteId: 'site', tenantId: 'tenant', status: 'approved' },
    ]);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai.experiments_ready', targetId: 'insight' }), tx);
    expect(audit.log.mock.calls.every(call => call[1] === tx)).toBe(true);
  });

  it('makes repeated approval and delivery idempotent without rerunning preparation', async () => {
    const { service, tx, audit } = setup();
    const approval = await service.approve(user, 'insight');
    expect(await service.approve(user, 'insight')).toEqual(approval);
    const ready = await service.completeExperiments('tenant', 'insight', proposals);
    expect(await service.completeExperiments('tenant', 'insight', proposals)).toEqual(ready);
    expect(tx.experiment.create).toHaveBeenCalledTimes(2);
    expect(audit.log).toHaveBeenCalledTimes(4);
  });

  it('rolls back an unaudited approval and a partially persisted delivery', async () => {
    const { insight, audit, service } = setup(); audit.log.mockRejectedValueOnce(new Error('Audit unavailable'));
    await expect(service.approve(user, 'insight')).rejects.toThrow('Audit unavailable');
    expect(insight.approvedAt).toBeNull();
    await service.approve(user, 'insight');
    audit.log.mockRejectedValueOnce(new Error('Delivery audit unavailable'));
    await expect(service.completeExperiments('tenant', 'insight', proposals)).rejects.toThrow('Delivery audit unavailable');
    expect(insight.approvedAt).toBeInstanceOf(Date);
    expect(insight.experimentsReadyAt).toBeNull();
    expect(insight.experiments).toEqual([]);
  });

  it('preserves legacy live experiments and approves existing drafts without duplicating them', async () => {
    const { insight, tx, service } = setup();
    insight.experiments.push({ id: 'live', name: 'Existente', status: 'running' }, { id: 'draft', name: 'Proposta anterior', status: 'ai_suggested' });
    const result = await service.approve(user, 'insight');
    expect(result.experimentsReadyAt).toBeInstanceOf(Date);
    expect(result.experiments.map(experiment => experiment.status)).toEqual(['running', 'approved']);
    expect(tx.experiment.create).not.toHaveBeenCalled();
    expect(tx.approval.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ experimentId: 'draft', status: 'approved', approverUserId: 'user' }) }));
  });

  it('rejects concurrent legacy status changes rather than overwriting a reviewer decision', async () => {
    const { insight, tx, service } = setup();
    insight.experiments.push({ id: 'changed', name: 'Alterado', status: 'pending_review' });
    tx.experiment.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.approve(user, 'insight')).rejects.toMatchObject({ status: 409 });
    expect(insight.approvedAt).toBeNull();
  });

  it('denies foreign and unknown insights before mutating them', async () => {
    const { insight, tx, service } = setup(); insight.tenantId = 'other';
    await expect(service.approve(user, 'insight')).rejects.toMatchObject({ status: 403 });
    await expect(service.completeExperiments('tenant', 'insight', proposals)).rejects.toMatchObject({ status: 403 });
    tx.aiSuggestion.findUnique.mockResolvedValueOnce(null as never);
    await expect(service.approve(user, 'missing')).rejects.toMatchObject({ status: 404 });
    expect(tx.aiSuggestion.update).not.toHaveBeenCalled(); expect(tx.experiment.create).not.toHaveBeenCalled();
  });

  it('does not approve or deliver work for an archived workspace', async () => {
    const { insight, tx, service } = setup(); insight.tenant.archivedAt = new Date();
    await expect(service.approve(user, 'insight')).rejects.toMatchObject({ status: 403 });
    await expect(service.completeExperiments('tenant', 'insight', proposals)).rejects.toMatchObject({ status: 403 });
    expect(tx.aiSuggestion.update).not.toHaveBeenCalled(); expect(tx.experiment.create).not.toHaveBeenCalled();
  });

  it.each(['stub-v1', 'synthetic-demo'])('rejects approval of %s demonstrations', async model => {
    const { insight, tx, service } = setup(); insight.model = model;
    await expect(service.approve(user, 'insight')).rejects.toMatchObject({ status: 400 });
    expect(tx.aiSuggestion.update).not.toHaveBeenCalled();
  });

  it.each([{ maxLength: 3 }, { bannedWords: ['PLANOS'] }])('validates delivered results against current guidelines: %j', async rules => {
    const { insight, tx, service } = setup();
    await service.approve(user, 'insight'); tx.aiSuggestion.update.mockClear();
    tx.brandGuardrail.findUnique.mockResolvedValue({ rules } as never);
    await expect(service.completeExperiments('tenant', 'insight', proposals)).rejects.toMatchObject({ status: 400 });
    expect(tx.aiSuggestion.update).not.toHaveBeenCalled(); expect(tx.experiment.create).not.toHaveBeenCalled();
    expect(insight.experimentsReadyAt).toBeNull();
  });

  it('rejects empty/invalid deliveries and bounds proposals before creating any results', async () => {
    const { tx, service } = setup(); await service.approve(user, 'insight'); tx.aiSuggestion.update.mockClear();
    for (const delivered of [[], [proposals[0], { selector: 'input[value="private"]', proposedValue: 'Unsafe' }]]) {
      await expect(service.completeExperiments('tenant', 'insight', delivered)).rejects.toMatchObject({ status: 400 });
    }
    expect(tx.aiSuggestion.update).not.toHaveBeenCalled(); expect(tx.experiment.create).not.toHaveBeenCalled();
    expect(InsightExperimentProposalsSchema.safeParse(Array(11).fill(proposals[0])).success).toBe(false);
  });

  it('filters experiments and their review queue by origin without losing site and tenant boundaries', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await new ExperimentsService({ experiment: { findMany } } as never, {} as never, {} as never, {} as never).list('tenant', { siteId: 'site', insightId: 'insight' });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant', siteId: 'site', insightId: 'insight' } }));
    findMany.mockClear();
    await new ApprovalsService({ approval: { findMany } } as never).listQueue('tenant', 'pending', 'site', 'insight');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'pending', experiment: { tenantId: 'tenant', siteId: 'site', insightId: 'insight' } } }));
    expect(ExperimentQuerySchema.safeParse({ insightId: 'invalid' }).success).toBe(false);
    expect(ApprovalQuerySchema.safeParse({ insightId: 'invalid' }).success).toBe(false);
  });
});

const httpState = { role: 'editor' };
const httpAi = { approve: vi.fn(), analyze: vi.fn(), listSuggestions: vi.fn() };
@Module({ controllers: [AiController], providers: [
  { provide: AiService, useValue: httpAi },
  { provide: APP_GUARD, useValue: { canActivate(context: ExecutionContext) { context.switchToHttp().getRequest().user = { ...user, role: httpState.role }; return true; } } },
  { provide: APP_GUARD, useClass: RolesGuard },
] })
class ApprovalHttpModule {}

describe('insight approval HTTP boundary', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(ApprovalHttpModule, createHttpAdapter(), { logger: false });
    app.setGlobalPrefix('v1'); await app.init(); await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    vi.clearAllMocks(); httpState.role = 'editor';
    httpAi.approve.mockResolvedValue({ approvedAt: new Date('2026-11-21T12:00:00Z'), experimentsReadyAt: null, experiments: [] });
    httpAi.listSuggestions.mockResolvedValue([]);
  });

  it('exposes approval to editors while denying viewers', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/ai/suggestions/insight/approve' })).statusCode).toBe(201);
    expect(httpAi.approve).toHaveBeenCalledWith(user, 'insight');
    httpState.role = 'viewer'; httpAi.approve.mockClear();
    expect((await app.inject({ method: 'POST', url: '/v1/ai/suggestions/insight/approve' })).statusCode).toBe(403);
    expect(httpAi.approve).not.toHaveBeenCalled();
  });

  it('does not expose manual analysis or the previous direct-materialization action', async () => {
    for (const url of ['/v1/sites/site/ai/analyze', '/v1/ai/suggestions/insight/materialize', '/v1/ai/suggestions/insight/complete']) {
      expect((await app.inject({ method: 'POST', url })).statusCode).toBe(404);
    }
    expect(httpAi.analyze).not.toHaveBeenCalled(); expect(httpAi.approve).not.toHaveBeenCalled();
  });

  it('loads a specific origin insight with a validated, tenant-scoped query', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect((await app.inject({ method: 'GET', url: `/v1/sites/site/ai/suggestions?insightId=${id}` })).statusCode).toBe(200);
    expect(httpAi.listSuggestions).toHaveBeenCalledWith('tenant', 'site', id);
    httpAi.listSuggestions.mockClear();
    expect((await app.inject({ method: 'GET', url: '/v1/sites/site/ai/suggestions?insightId=invalid' })).statusCode).toBe(400);
    expect(httpAi.listSuggestions).not.toHaveBeenCalled();
  });
});
