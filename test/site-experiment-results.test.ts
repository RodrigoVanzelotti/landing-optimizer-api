import 'reflect-metadata';
import { expect, it, vi } from 'vitest';
import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import { buildExperimentResults, experimentResultsQuery, type ResultExperiment } from '../src/modules/analytics/experiment-results';
import { postgresQuery } from '../src/modules/analytics/clickhouse/postgres-query';

const experiments: ResultExperiment[] = [
  { id: 'first', endedAt: new Date('2026-11-20T00:00:00Z'), primaryGoal: { name: 'lead' }, variants: [{ id: 'control', name: 'Controle', isControl: true }, { id: 'new', name: 'Nova chamada', isControl: false }] },
  { id: 'second', endedAt: null, primaryGoal: null, variants: [{ id: 'second-control', name: 'Controle', isControl: true }, { id: 'second-new', name: 'Outro título', isControl: false }] },
];

it('calculates each experiment separately, includes variant names and preserves zero-exposure experiments', () => {
  const results = buildExperimentResults(experiments, [
    { experiment_id: 'first', variant_id: 'control', exposures: '1000', conversions: '100' },
    { experiment_id: 'first', variant_id: 'new', exposures: '1000', conversions: '150' },
    { experiment_id: 'unknown', variant_id: 'new', exposures: '9999', conversions: '9999' },
  ]);
  expect(results).toHaveLength(2);
  expect(results[0]!.variants[1]).toMatchObject({ name: 'Nova chamada', conversionRate: .15, significant: true });
  expect(results[0]!.variants[1]!.lift).toBeCloseTo(.5);
  expect(results[1]!.variants.every(variant => variant.exposures === 0 && !variant.significant)).toBe(true);
});

it('binds per-experiment goals and end dates and translates the batch query for PostgreSQL', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const query = experimentResultsQuery(experiments, now);
  expect(query.params).toMatchObject({ experiment0: 'first', goal0: 'lead', end0: '2026-11-20 00:00:00.000', experiment1: 'second', goal1: '', end1: '2026-11-21 12:00:00.000' });
  expect(query.sql).toContain('c.converted_at >= e.first_exposure');
  expect(query.sql).toContain('c.converted_at <= m.ended_at');
  expect(query.sql).toContain("m.goal = '' OR c.goal = m.goal");
  const translated = postgresQuery(query.sql, { ...query.params, tenantId: 'tenant', siteId: 'site' });
  expect(translated.sql).not.toContain('{');
  expect(translated.values).toContain('lead');
});

it('authorizes the site before data reads and returns all summaries with one event query', async () => {
  const metadata = experiments.map(experiment => ({ ...experiment, name: experiment.id, siteId: 'site', allocation: '.5' }));
  const db = { site: { findUnique: vi.fn().mockResolvedValue({ tenantId: 'tenant' }) }, experiment: { findMany: vi.fn().mockResolvedValue(metadata) } };
  const query = vi.fn().mockResolvedValue([]);
  const service = new AnalyticsService(db as never, { query } as never);
  await expect(service.siteExperimentResults('other', 'site')).rejects.toMatchObject({ status: 403 });
  expect(db.experiment.findMany).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
  const result = await service.siteExperimentResults('tenant', 'site');
  expect(db.experiment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant', siteId: 'site' } }));
  expect(query).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ tenantId: 'tenant', siteId: 'site' }));
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ experiment: { id: 'first', allocation: .5 }, goal: { name: 'lead' } });
  query.mockClear(); db.experiment.findMany.mockResolvedValue([]);
  expect(await service.siteExperimentResults('tenant', 'site')).toEqual([]);
  expect(query).not.toHaveBeenCalled();
});

it('keeps final results readable when retained events are unavailable', async () => {
  const variantResults = [{ variantId: 'control', isControl: true, exposures: 10000, conversions: 1000, conversionRate: .1 }, { variantId: 'proposal', isControl: false, exposures: 10000, conversions: 1200, conversionRate: .12 }];
  const snapshot = { version: 1, experimentId: 'first', conclusive: true, coverageComplete: true, recordedAt: '2026-11-20', goal: { id: 'goal', name: 'Original goal' }, experiment: { siteId: 'site' }, variants: variantResults, series: [{ date: '2026-11-20', variants: [] }] };
  const db = { site: { findUnique: vi.fn().mockResolvedValue({ tenantId: 'tenant' }) }, experiment: { findMany: vi.fn().mockResolvedValue([{ ...experiments[0], siteId: 'site', name: 'Name', allocation: .5, resultSnapshot: snapshot }]) } };
  const query = vi.fn().mockRejectedValue(new Error('event store unavailable'));
  const results = await new AnalyticsService(db as never, { query } as never).siteExperimentResults('tenant', 'site');
  expect(query).not.toHaveBeenCalled();
  expect(results[0]).toMatchObject({ conclusive: true, variants: variantResults, goal: { name: 'Original goal' } });
});
