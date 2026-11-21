import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { insightKpis, InsightReferencesSchema, resolveInsightEvidence } from '../src/modules/ai/insight-evidence';
import { AiService } from '../src/modules/ai/ai.service';
import { AiClient } from '../src/modules/ai/ai.client';
import type { AnalyticsService } from '../src/modules/analytics/analytics.service';

function report(): Awaited<ReturnType<AnalyticsService['report']>> {
  return {
    timeframe: '30d', timezone: 'UTC', granularity: 'day',
    range: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z', previousFrom: '2026-09-01T00:00:00.000Z', previousTo: '2026-10-01T00:00:00.000Z' },
    coverage: { currentComplete: true, previousComplete: true, availableFrom: '2026-01-01T00:00:00.000Z' },
    current: { pageViews: 100, sessions: 80, ctaClicks: 20, conversions: 5, formSubmits: 6, formStarts: 10, formCompletions: 4, formCompletionRate: 0.4 },
    previous: { pageViews: 50, sessions: 40, ctaClicks: 5, conversions: 1, formSubmits: 3, formStarts: 8, formCompletions: 2, formCompletionRate: 0.25 },
    sections: [{ section: 'pricing', views: 30, deadClicks: 7, rageClicks: 2, dwellMs: 20000 }],
    series: [], events: [],
  };
}
const pageMap = { urlPath: '/pricing', capturedAt: new Date('2026-10-30T12:00:00Z'), map: { nodes: [{ selector: '#cta', tag: 'button', role: 'cta', text: 'Saiba mais' }] } };
const suggestion = { kind: 'cta' as const, title: 'Explicitar o próximo passo', detail: 'Hipótese para testar a clareza da chamada.', riskLevel: 'low' as const, selector: '#cta', proposedValue: 'Conhecer os planos', kpiKeys: ['ctaClicks', 'ctaClicksPerView'] };
const user = { userId: 'user', tenantId: 'tenant', email: 'editor@example.com', role: 'editor' as const };
afterEach(() => vi.restoreAllMocks());

describe('insight evidence from ingested data', () => {
  it('uses measured event/session denominators and preserves different kinds of KPI', () => {
    const kpis = insightKpis(report());
    expect(kpis.find(item => item.key === 'ctaClicksPerView')).toMatchObject({ value: 0.2, numerator: 20, denominator: 100, previousValue: 0.1 });
    expect(kpis.find(item => item.key === 'formCompletionRate')).toMatchObject({ value: 0.4, numerator: 4, denominator: 10, previousValue: 0.25 });
    expect(kpis.find(item => item.key === 'section:pricing:deadClicks')).toMatchObject({ value: 7, unit: 'count' });
    expect(kpis.find(item => item.key === 'section:pricing:dwellMs')).toMatchObject({ value: 20000, unit: 'milliseconds' });
  });

  it('keeps missing denominators unavailable and suppresses comparisons with partial history', () => {
    const data = report(); data.current.formStarts = 0; data.coverage.previousComplete = false;
    const kpis = insightKpis(data);
    expect(kpis.find(item => item.key === 'formCompletionRate')?.value).toBeNull();
    expect(kpis.every(item => item.previousValue === undefined)).toBe(true);
    data.current.ctaClicks = 150;
    expect(insightKpis(data).find(item => item.key === 'ctaClicksPerView')?.value).toBe(1.5);
  });

  it('resolves a variable selection of KPIs and only includes design context when supplied', () => {
    const data = report(), catalog = insightKpis(data);
    const twoKpis = resolveInsightEvidence({ kpiKeys: ['ctaClicks', 'ctaClicksPerView'] }, data, catalog, pageMap);
    expect(twoKpis.kpis?.map(kpi => kpi.value)).toEqual([20, 0.2]);
    expect(twoKpis).not.toHaveProperty('designContext');
    const design = resolveInsightEvidence({ kpiKeys: ['ctaClicksPerView'], designContext: { selector: '#cta', observation: 'O texto atual pode deixar o destino pouco claro.' } }, data, catalog, pageMap);
    expect(design.kpis).toHaveLength(1);
    expect(design.designContext).toMatchObject({ selector: '#cta', text: 'Saiba mais', pagePath: '/pricing', capturedAt: '2026-10-30T12:00:00.000Z' });
    expect(resolveInsightEvidence({}, data, catalog, null)).not.toHaveProperty('kpis');
    expect(InsightReferencesSchema.parse({ kpiKeys: null, designContext: null })).toEqual({ kpiKeys: undefined, designContext: undefined });
  });

  it('rejects invented KPI and DOM references instead of attaching unrelated evidence', () => {
    const data = report(), catalog = insightKpis(data);
    expect(() => resolveInsightEvidence({ kpiKeys: ['invented_revenue'] }, data, catalog, pageMap)).toThrow('Unknown KPI');
    expect(() => resolveInsightEvidence({ designContext: { selector: '#not-captured' } }, data, catalog, pageMap)).toThrow('Unknown design');
    for (const refs of [{ kpiKeys: ['sessions', 'sessions'] }, { kpiKeys: Array.from({ length: 7 }, (_, i) => `kpi${i}`) }, { designContext: { selector: 'input[value="private"]' } }]) expect(InsightReferencesSchema.safeParse(refs).success).toBe(false);
  });

  it('records partial coverage and never invents historical values', () => {
    const data = report(); data.coverage.currentComplete = false; data.coverage.availableFrom = '2026-10-15T00:00:00.000Z';
    const evidence = resolveInsightEvidence({ kpiKeys: ['sessions'] }, data, insightKpis(data), null);
    expect(evidence.analysisPeriod).toMatchObject({ partial: true, observedFrom: '2026-10-15T00:00:00.000Z', sessions: 80 });
    expect(evidence.analysisPeriod).not.toHaveProperty('comparison');
    expect(evidence.kpis![0]).not.toHaveProperty('previousValue');
  });
});

function setup() {
  const data = report();
  const create = vi.fn().mockResolvedValue({});
  const findMany = vi.fn().mockResolvedValue([]);
  const prisma = {
    site: { findUnique: vi.fn().mockResolvedValue({ tenantId: 'tenant' }) },
    brandGuardrail: { findUnique: vi.fn().mockResolvedValue(null) },
    pageMap: { findFirst: vi.fn().mockResolvedValue(pageMap) },
    aiSuggestion: { create, findMany },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  const analytics = { report: vi.fn().mockResolvedValue(data) };
  const ai = { analyze: vi.fn().mockResolvedValue({ model: 'production', score: 70, suggestions: [suggestion] }) };
  const service = new AiService(prisma as never, analytics as never, ai as never, { log: vi.fn() } as never);
  return { data, prisma, analytics, ai, create, findMany, service };
}

describe('AI API evidence contract', () => {
  it('persists a period-aligned snapshot of authoritative KPI values', async () => {
    const { data, analytics, ai, create, service } = setup();
    expect(await service.analyze(user, 'site')).toEqual({ count: 1, score: 70 });
    expect(analytics.report).toHaveBeenCalledWith('tenant', 'site', '30d');
    expect(ai.analyze).toHaveBeenCalledWith(expect.objectContaining({ metrics: expect.objectContaining({ kpis: expect.arrayContaining([expect.objectContaining({ key: 'ctaClicksPerView', value: 0.2 })]) }) }), undefined);
    const payload = create.mock.calls[0][0].data.payload;
    expect(payload).toMatchObject({ analysisPeriod: { from: data.range.from, to: data.range.to, sessions: 80 }, kpis: [{ key: 'ctaClicks', value: 20 }, { key: 'ctaClicksPerView', value: 0.2 }] });
    data.current.ctaClicks = 999;
    expect(payload.kpis[0].value).toBe(20);
  });

  it('does not call the model when there is no traffic to support insights', async () => {
    const { data, service, ai, create } = setup(); data.current.pageViews = 0;
    await expect(service.analyze(user, 'site')).rejects.toMatchObject({ status: 400 });
    expect(ai.analyze).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it.each(['stub-v1', 'synthetic-demo'])('rejects generated demonstration results from %s', async model => {
    const { ai, create, service } = setup(); ai.analyze.mockResolvedValue({ model, score: 70, suggestions: [suggestion] });
    await expect(service.analyze(user, 'site')).rejects.toMatchObject({ status: 503 }); expect(create).not.toHaveBeenCalled();
  });

  it('rejects unknown references before any suggestion is persisted', async () => {
    const { ai, create, service } = setup();
    ai.analyze.mockResolvedValue({ model: 'production', score: 70, suggestions: [suggestion, { ...suggestion, kpiKeys: ['invented_revenue'] }] });
    await expect(service.analyze(user, 'site')).rejects.toMatchObject({ status: 503 }); expect(create).not.toHaveBeenCalled();
  });

  it('keeps legacy payloads unchanged rather than attributing current data to old insights', async () => {
    const { findMany, analytics, service } = setup();
    const rows = [{ id: 'legacy', payload: { title: 'Antigo' } }]; findMany.mockResolvedValue(rows as never);
    expect(await service.listSuggestions('tenant', 'site')).toEqual(rows);
    expect(analytics.report).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant', siteId: 'site', model: { notIn: ['stub-v1', 'synthetic-demo'] } } }));
  });

  it('enforces tenant ownership before reading or attributing analytics', async () => {
    const { prisma, analytics, service } = setup(); prisma.site.findUnique.mockResolvedValue({ tenantId: 'other' });
    await expect(service.analyze(user, 'site')).rejects.toMatchObject({ status: 403 });
    expect(analytics.report).not.toHaveBeenCalled();
  });

  it('accepts optional model references while discarding model-supplied KPI values', async () => {
    const client = new AiClient(new ConfigService({ AI_SERVICE_URL: 'https://ai.example', AI_SERVICE_TOKEN: 'test' }) as never);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ model: 'production', score: 70, suggestions: [{ ...suggestion, kpis: [{ key: 'ctaClicks', value: 999 }], designContext: { selector: '#cta', observation: 'Hipótese' } }] }));
    const result = await client.analyze({ siteId: 'site', pageMap: {}, metrics: {} });
    expect(result?.suggestions[0]).toMatchObject({ kpiKeys: ['ctaClicks', 'ctaClicksPerView'], designContext: { selector: '#cta', observation: 'Hipótese' } });
    expect(result?.suggestions[0]).not.toHaveProperty('kpis');
  });
});
