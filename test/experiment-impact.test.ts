import { afterEach, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import { buildExperimentImpact, ExperimentImpactQuerySchema, impactQuery, type ImpactExperiment, type ImpactRow } from '../src/modules/analytics/experiment-impact';
import { reportRange } from '../src/modules/analytics/report';
import { postgresQuery } from '../src/modules/analytics/clickhouse/postgres-query';

const now = new Date('2026-11-21T12:00:00Z');
const range = reportRange('7d', now);
const history = '2020-01-01T00:00:00.000Z';
const experiment: ImpactExperiment = { id: 'experiment', name: 'Chamada clara', status: 'running', startedAt: new Date('2026-11-07Z'), endedAt: null, variants: [{ id: 'control', isControl: true }, { id: 'variant', isControl: false }] };
const row = (variant_id: string, exposure_date: string, conversion_date: string | null, exposures: number, conversions: number): ImpactRow => ({ experiment_id: experiment.id, variant_id, exposure_date, conversion_date, exposures, conversions, excluded: 0 });
afterEach(() => { vi.useRealTimers(); });

it('validates a site, objective and bounded timeframe at the HTTP boundary', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  expect(ExperimentImpactQuerySchema.parse({ siteId: id, goalId: id }).timeframe).toBe('30d');
  for (const query of [{ siteId: id }, { siteId: id, goalId: 'bad' }, { siteId: id, goalId: id, timeframe: 'all' }]) expect(ExperimentImpactQuerySchema.safeParse(query).success).toBe(false);
});

it('weights rates by exposures, includes provisional tests and does not bring future conversions into earlier points', () => {
  const rows = [row('control', '2026-11-14', '2026-11-16', 100, 10), row('variant', '2026-11-14', '2026-11-15', 100, 20), row('control', '2026-11-07', '2026-11-09', 50, 5), row('variant', '2026-11-07', '2026-11-09', 50, 8)];
  const report = buildExperimentImpact('7d', range, history, [experiment], rows);
  expect(report.current.control.rate).toBe(.1);
  expect(report.current.variants.rate).toBe(.2);
  expect(report.current.gainPp).toBe(10);
  expect(report.previous.gainPp).toBeCloseTo(6);
  expect(report.series[0]!.values?.control.rate).toBe(0);
  expect(report.series[0]!.values?.variants.rate).toBe(0);
  expect(report.series[1]!.values?.variants.rate).toBe(.2);
  expect(report.series[1]!.values?.control.rate).toBe(0);
  expect(report.series.at(-1)!.values).toEqual(report.current);
  expect(report.experiments[0]).toMatchObject({ partial: true, gainPp: 10 });
  const weighted = buildExperimentImpact('7d', range, history, [experiment], [...rows, row('control', '2026-11-17', null, 900, 0)]);
  expect(weighted.current.control.rate).toBe(.01);
});

it('keeps missing samples and retained-history gaps distinct from zero and reports excluded ambiguous exposures', () => {
  const report = buildExperimentImpact('7d', range, '2026-11-17T00:00:00.000Z', [experiment], [{ ...row('control', '2026-11-18', null, 0, 0), excluded: 2 }, { ...row('unknown-variant', '2026-11-18', null, 100, 50) }]);
  expect(report.series[0]!.values).toBeNull();
  expect(report.current.control.rate).toBeNull();
  expect(report.current.gainPp).toBeNull();
  expect(report.excludedExposures).toBe(2);
  expect(report.coverage.currentComplete).toBe(false);
  expect(report.coverage.previousComplete).toBe(false);
});

it.each(['7d', '30d', '6m', '1y'] as const)('ends cumulative buckets at the exact requested boundary: %s', timeframe => {
  const selected = reportRange(timeframe, now);
  const report = buildExperimentImpact(timeframe, selected, history, [], []);
  expect(report.series.at(-1)!.to).toBe(selected.to);
  expect(report.series.every(bucket => bucket.values?.gainPp === null)).toBe(true);
});

it('authorizes site and goal before reading events and filters experiments by site, tenant and compatible objective', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  const query = vi.fn().mockResolvedValue([]);
  const site = { tenantId: 'tenant', createdAt: new Date(history) };
  const db = { site: { findUnique: vi.fn().mockResolvedValue(site) }, conversionGoal: { findFirst: vi.fn().mockResolvedValue({ id: 'goal', name: 'lead', createdAt: new Date(history), isFavorite: true }) }, experiment: { findMany: vi.fn().mockResolvedValue([experiment]) } };
  const service = new AnalyticsService(db as never, { query, retentionDays: null } as never);
  await expect(service.experimentImpact('foreign', { siteId: 'site', goalId: 'goal', timeframe: '7d' })).rejects.toMatchObject({ status: 403 });
  expect(query).not.toHaveBeenCalled();
  const report = await service.experimentImpact('tenant', { siteId: 'site', goalId: 'goal', timeframe: '7d' });
  expect(report.goal).toEqual({ id: 'goal', name: 'lead', isFavorite: true });
  expect(db.conversionGoal.findFirst).toHaveBeenCalledWith({ where: { id: 'goal', siteId: 'site' } });
  expect(db.experiment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant', siteId: 'site', AND: expect.arrayContaining([{ OR: [{ primaryGoalId: 'goal' }, { primaryGoalId: null }] }]) }) }));
  expect(query).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ tenantId: 'tenant', siteId: 'site', goal: 'lead' }));
  db.conversionGoal.findFirst.mockResolvedValue(null as never); query.mockClear();
  await expect(service.experimentImpact('tenant', { siteId: 'site', goalId: 'foreign-goal', timeframe: '7d' })).rejects.toMatchObject({ status: 404 });
  expect(query).not.toHaveBeenCalled();
});

it('binds dynamic experiment metadata and translates the same attribution query for PostgreSQL', () => {
  const query = impactQuery([experiment], range, history);
  expect(query.sql).not.toContain(`'${experiment.id}'`);
  const translated = postgresQuery(query.sql, { ...query.params, tenantId: 'tenant', siteId: 'site', goal: 'lead' });
  expect(translated.sql).not.toContain('{');
  expect(translated.values).toContain('lead');
  expect(query.sql).toContain('assignment_count = 1');
  expect(query.sql).toContain('c.converted_at >= e.first_exposure');
  expect(query.sql).toContain('c.converted_at < m.ended_at');
});

it.skipIf(!process.env['ANALYTICS_TEST_DATABASE_URL'])('executes attribution with delayed conversions, duplicates, overlap, period bounds and site isolation in PostgreSQL', async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env['ANALYTICS_TEST_DATABASE_URL']! } } });
  try {
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE events (tenant_id text, site_id text, session_id text, event_name text, event_time timestamp, experiment_id text, variant_id text, goal text, is_bot int) ON COMMIT DROP`);
      const records: Record<string, unknown>[] = [];
      function event(session: string, name: string, time: string, variant = 'control', exp = 'experiment', extra = {}) {
        records.push({ tenant_id: 'tenant', site_id: 'site', session_id: session, event_name: name, event_time: time, experiment_id: exp, variant_id: variant, goal: 'lead', is_bot: 0, ...extra });
      }
      event('control-session', 'exposure', '2026-11-14 01:00'); event('control-session', 'exposure', '2026-11-14 01:01');
      event('control-session', 'conversion', '2026-11-16 01:00'); event('control-session', 'conversion', '2026-11-17 01:00');
      event('variant-session', 'exposure', '2026-11-14 02:00', 'variant'); event('variant-session', 'conversion', '2026-11-15 01:00', 'variant');
      event('before', 'conversion', '2026-11-14 01:00'); event('before', 'exposure', '2026-11-14 03:00');
      event('overlap', 'exposure', '2026-11-14 02:00'); event('overlap', 'exposure', '2026-11-14 02:00', 'other', 'other-experiment'); event('overlap', 'conversion', '2026-11-14 03:00');
      event('late', 'exposure', '2026-11-14 02:00', 'variant'); event('late', 'conversion', '2026-11-20 03:00', 'variant');
      event('prior', 'exposure', '2026-11-13 02:00'); event('prior', 'conversion', '2026-11-14 03:00');
      event('foreign', 'exposure', '2026-11-14 02:00', 'variant', 'experiment', { site_id: 'other' });
      await tx.$executeRaw`INSERT INTO events SELECT * FROM jsonb_populate_recordset(NULL::events, ${JSON.stringify(records)}::jsonb)`;
      const ended = { ...experiment, endedAt: new Date('2026-11-19Z') };
      const query = impactQuery([ended], range, history);
      const sql = postgresQuery(query.sql, { ...query.params, tenantId: 'tenant', siteId: 'site', goal: 'lead' });
      const rows = await tx.$queryRawUnsafe<ImpactRow[]>(sql.sql, ...sql.values);
      const report = buildExperimentImpact('7d', range, history, [ended], rows);
      expect(report.current.control).toEqual({ exposures: 2, conversions: 1, rate: .5 });
      expect(report.current.variants).toEqual({ exposures: 2, conversions: 1, rate: .5 });
      expect(report.previous.control.conversions).toBe(0);
      expect(report.excludedExposures).toBe(1);
      expect(report.series[0]!.values?.control.conversions).toBe(0);
      expect(report.series[1]!.values?.variants.conversions).toBe(1);
      expect(report.series[2]!.values?.control.conversions).toBe(1);
    });
  } finally { await prisma.$disconnect(); }
}, 30_000);
