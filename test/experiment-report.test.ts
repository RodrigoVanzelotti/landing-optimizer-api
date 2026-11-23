import 'reflect-metadata';
import { expect, it, vi } from 'vitest';
import { ExperimentReportService } from '../src/modules/analytics/experiment-report.service';
import { buildTimeline, timelineQuery } from '../src/modules/analytics/experiment-report';
import { postgresQuery } from '../src/modules/analytics/clickhouse/postgres-query';

const variants = [{ id: 'control', name: 'Controle', isControl: true }, { id: 'proposal', name: 'Proposta', isControl: false }];
it('accumulates genuine daily cohorts, carries rates through empty days and keeps no-exposure rates unavailable', () => {
  const result = buildTimeline(variants, [
    { date: '2026-11-01', variant_id: 'control', exposures: '100', conversions: '10' },
    { date: '2026-11-03', variant_id: 'proposal', exposures: '200', conversions: '24' },
    { date: '2026-11-04', variant_id: 'control', exposures: '100', conversions: '10' },
  ], new Date('2026-11-01'), new Date('2026-11-05'));
  expect(result.series).toHaveLength(4);
  expect(result.series[0]?.variants[1]?.conversionRate).toBeNull();
  expect(result.series[1]?.variants[0]?.conversionRate).toBe(.1);
  expect(result.series[3]?.variants[1]?.conversionRate).toBe(.12);
  expect(result.variants[1]?.lift).toBeCloseTo(.2);
});
it('binds authorized identities, excludes ambiguous assignments and pilot sessions, and translates the observation window for PostgreSQL', () => {
  const query = timelineQuery();
  expect(query).toContain('a.arms = 1');
  expect(query).toContain('e.first_exposure >= {from:DateTime64}');
  expect(query).toContain('c.converted_at >= e.first_exposure');
  const translated = postgresQuery(query, { tenantId: 'tenant', siteId: 'site', experimentId: 'experiment', from: '2026-11-01', started: '2026-10-28', to: '2026-11-20', cutoff: '2026-11-19', goal: 'lead' });
  expect(translated.sql).toContain("INTERVAL '24 hours'");
  expect(translated.sql).not.toContain('{');
  expect(translated.values).toContain('tenant'); expect(translated.values).toContain('lead');
});
it('checks tenant ownership before analytics and serves a frozen snapshot without re-reading retained events', async () => {
  const snapshot = { version: 1, experimentId: 'experiment', conclusive: true, coverageComplete: true, recordedAt: '2026-11-20', experiment: { id: 'experiment', siteId: 'site', name: 'Name', status: 'completed' }, variants: [{ isControl: true, exposures: 1000, conversions: 100 }, { isControl: false, exposures: 1000, conversions: 120 }], series: [{ date: '2026-11-20', variants: [] }] };
  const db = { experiment: { findUnique: vi.fn().mockResolvedValue({ id: 'experiment', tenantId: 'tenant', siteId: 'site', status: 'accepted', resultSnapshot: snapshot }) } };
  const query = vi.fn();
  const reports = new ExperimentReportService(db as never, { query } as never);
  await expect(reports.report('foreign', 'experiment')).rejects.toMatchObject({ status: 403 });
  expect(query).not.toHaveBeenCalled();
  expect(await reports.report('tenant', 'experiment')).toMatchObject({ conclusive: true, experiment: { status: 'accepted' } });
  expect(query).not.toHaveBeenCalled();
});
