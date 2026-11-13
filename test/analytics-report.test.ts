import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildReport, reportRange, ReportQuerySchema, SESSION_REPORT_SQL } from '../src/modules/analytics/report';
import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import { postgresQuery } from '../src/modules/analytics/clickhouse/postgres-query';

const now = new Date('2026-11-13T16:40:00Z');
const history = '2020-01-01T00:00:00.000Z';
afterEach(() => { vi.useRealTimers(); });

describe('analytics reports', () => {
  it('validates sites and the four bounded timeframes', () => {
    expect(ReportQuerySchema.parse({ siteId: '11111111-1111-4111-8111-111111111111' }).timeframe).toBe('30d');
    expect(ReportQuerySchema.safeParse({ siteId: 'bad', timeframe: 'all' }).success).toBe(false);
    expect(ReportQuerySchema.safeParse({ siteId: '11111111-1111-4111-8111-111111111111', timeframe: 'all' }).success).toBe(false);
  });
  it.each(['7d', '30d', '6m', '1y'] as const)('uses complete UTC days and adjacent, equally long periods: %s', timeframe => {
    const range = reportRange(timeframe, now);
    expect(range.to).toBe('2026-11-13T00:00:00.000Z');
    expect(range.previousTo).toBe(range.from);
    expect(Date.parse(range.to) - Date.parse(range.from)).toBe(Date.parse(range.previousTo) - Date.parse(range.previousFrom));
  });
  it('clamps calendar subtraction at month ends and leap days', () => {
    expect(reportRange('6m', new Date('2026-08-31Z')).from).toBe('2026-02-28T00:00:00.000Z');
    expect(reportRange('1y', new Date('2024-02-29Z')).from).toBe('2023-02-28T00:00:00.000Z');
  });
  it('fills missing days and calculates weighted completion rates instead of averaging daily rates', () => {
    const result = buildReport('7d', reportRange('7d', now), history,
      [{ date: '2026-11-06', metric: 'page_view', count: '10' }, { date: '2026-10-30', metric: 'page_view', count: '5' }],
      [{ date: '2026-11-06', metric: 'formStarts', count: '1' }, { date: '2026-11-06', metric: 'formCompletions', count: '1' }, { date: '2026-11-07', metric: 'formStarts', count: '9' }], []);
    expect(result.series).toHaveLength(7);
    expect(result.current.formCompletionRate).toBe(.1);
    expect(result.previous.pageViews).toBe(5);
    expect(result.series[2]!.current!.pageViews).toBe(0);
    expect(result.series[2]!.current!.formCompletionRate).toBeNull();
    expect(result.events).toEqual([{ event: 'page_view', count: 10 }]);
  });
  it('shows unavailable history as gaps and marks incomplete comparisons', () => {
    const range = reportRange('1y', now);
    const result = buildReport('1y', range, '2026-05-17T00:00:00.000Z', [], [], []);
    expect(result.coverage.currentComplete).toBe(false);
    expect(result.coverage.previousComplete).toBe(false);
    expect(result.series[0]!.current).toBeNull();
    expect(result.series.every(row => row.previous === null)).toBe(true);
    expect(result.series.at(-1)!.current!.pageViews).toBe(0);
    expect(result.series.at(-1)!.to).toBe(range.to);
  });
  it('authorizes site ownership before querying behavioral data', async () => {
    const query = vi.fn();
    const service = new AnalyticsService({ site: { findUnique: vi.fn().mockResolvedValue({ tenantId: 'other' }) } } as never, { query } as never);
    await expect(service.report('tenant', 'site', '7d')).rejects.toThrow('Cross-tenant access');
    expect(query).not.toHaveBeenCalled();
  });
});

it.skipIf(!process.env['ANALYTICS_TEST_DATABASE_URL'])('executes the report against PostgreSQL with ordered, deduplicated form journeys', async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env['ANALYTICS_TEST_DATABASE_URL']! } } });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  try {
    await prisma.$transaction(async tx => {
      // Temporary table shadows public.events only inside this isolated transaction.
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE events (
        tenant_id text, site_id text, session_id text, event_name text, event_time timestamp,
        selector text DEFAULT '', page_path text DEFAULT '/', is_bot int DEFAULT 0,
        section_id text DEFAULT '', dwell_ms int DEFAULT 0
      ) ON COMMIT DROP`);
      const records: string[][] = [];
      function event(session: string, name: string, time: string, selector = '#signup', path = '/') {
        records.push(['tenant', 'site', session, name, time, selector, path]);
      }
      // Duplicate starts/submits count once; a submit before a start does not complete it.
      for (const session of ['complete', 'before', 'wrong-form', 'wrong-page', 'late', 'repeat']) event(session, 'page_view', '2026-11-06 01:00');
      event('complete', 'form_start', '2026-11-06 02:00'); event('complete', 'form_submit', '2026-11-07 02:00');
      event('before', 'form_submit', '2026-11-06 01:30'); event('before', 'form_start', '2026-11-06 02:00');
      event('wrong-form', 'form_start', '2026-11-06 02:00'); event('wrong-form', 'form_submit', '2026-11-06 03:00', '#other');
      event('wrong-page', 'form_start', '2026-11-06 02:00'); event('wrong-page', 'form_submit', '2026-11-06 03:00', '#signup', '/other');
      event('late', 'form_start', '2026-11-06 02:00'); event('late', 'form_submit', '2026-11-13 01:00');
      event('repeat', 'form_start', '2026-11-06 02:00'); event('repeat', 'form_start', '2026-11-06 03:00');
      event('repeat', 'form_submit', '2026-11-06 04:00'); event('repeat', 'form_submit', '2026-11-06 05:00');
      event('previous', 'page_view', '2026-10-30 01:00'); event('previous', 'form_start', '2026-10-30 02:00'); event('previous', 'form_submit', '2026-10-30 03:00');
      const payload = records.map(([tenant_id, site_id, session_id, event_name, event_time, selector, page_path]) => ({ tenant_id, site_id, session_id, event_name, event_time, selector, page_path, is_bot: 0, section_id: 'hero', dwell_ms: 100 }));
      payload.push({ ...payload[1]!, tenant_id: 'another-tenant' });
      payload.push({ ...payload[1]!, session_id: 'bot', is_bot: 1 });
      await tx.$executeRaw`INSERT INTO events SELECT * FROM jsonb_populate_recordset(NULL::events, ${JSON.stringify(payload)}::jsonb)`;
      const query = async <T>(sql: string, params: Record<string, unknown>) => {
        const translated = postgresQuery(sql, params);
        return tx.$queryRawUnsafe<T[]>(translated.sql, ...translated.values);
      };
      const service = new AnalyticsService({ site: { findUnique: vi.fn().mockResolvedValue({ tenantId: 'tenant', createdAt: new Date(history) }) } } as never, { query, retentionDays: null } as never);
      const report = await service.report('tenant', 'site', '7d');
      expect(report.current).toMatchObject({ sessions: 6, formStarts: 6, formCompletions: 2, formCompletionRate: 2 / 6, formSubmits: 6 });
      expect(report.previous.formCompletionRate).toBe(1);
      expect(report.series[0]!.current!.formCompletions).toBe(2);
      expect(report.sections[0]!.section).toBe('hero');
      expect(JSON.stringify(report)).not.toContain('wrong-form');
      // All requested windows execute, including weekly aggregation and the year boundary.
      for (const timeframe of ['30d', '6m', '1y'] as const) expect((await service.report('tenant', 'site', timeframe)).series.length).toBeGreaterThan(0);
      expect(postgresQuery(SESSION_REPORT_SQL, { tenantId: 'tenant', siteId: 'site', from: '2026-11-06', to: '2026-11-13', previousFrom: '2026-10-30' }).sql).not.toContain('{');
    }, { timeout: 20000 });
  } finally { await prisma.$disconnect(); }
}, 30000);
