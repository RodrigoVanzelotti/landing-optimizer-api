import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { expect, it } from 'vitest';
import { ClickHouseService } from '../src/modules/analytics/clickhouse/clickhouse.service';
import { impactQuery, type ImpactRow } from '../src/modules/analytics/experiment-impact';
import { postgresQuery } from '../src/modules/analytics/clickhouse/postgres-query';
import { reportRange } from '../src/modules/analytics/report';
import { timelineQuery } from '../src/modules/analytics/experiment-report';
import { experimentResultsQuery } from '../src/modules/analytics/experiment-results';

it.skipIf(!process.env['ANALYTICS_TEST_DATABASE_URL'])('indexes conversion lookups and cancels slow analytics without keeping the pool connection', async () => {
  const url = new URL(process.env['ANALYTICS_TEST_DATABASE_URL']!);
  url.searchParams.set('connection_limit', '1');
  const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const service = new ClickHouseService(new ConfigService({ ANALYTICS_BACKEND: 'postgres' }), prisma as never);
  try {
    await expect(service.query('SELECT pg_sleep(9)')).rejects.toMatchObject({ code: 'P2010', meta: expect.objectContaining({ code: '57014' }) });
    expect(await service.query('SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
    expect(await prisma.$queryRawUnsafe('SHOW statement_timeout')).toEqual([{ statement_timeout: '0' }]);
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE events (tenant_id text, site_id text, session_id text, event_name text, event_time timestamp, experiment_id text, variant_id text, goal text, is_bot int) ON COMMIT DROP');
      await tx.$executeRawUnsafe(`INSERT INTO events SELECT 'tenant', 'site', n::text, kind,
        timestamp '2026-11-20' + CASE WHEN kind = 'conversion' THEN interval '1 hour' ELSE interval '0' END,
        'experiment', 'control', 'lead', 0 FROM generate_series(1, 8000) n CROSS JOIN (VALUES ('exposure'), ('conversion')) kinds(kind)`);
      await tx.$executeRawUnsafe(readFileSync('prisma/migrations/20261123210000_analytics_conversion_lookup/migration.sql', 'utf8'));
      const now = new Date('2026-11-23Z');
      const experiment = { id: 'experiment', name: 'Test', status: 'running', startedAt: new Date('2026-11-01Z'), endedAt: null, primaryGoal: { name: 'lead' }, variants: [] };
      const queries = [
        impactQuery([experiment], reportRange('7d', now), '2020-01-01T00:00:00.000Z'),
        { sql: timelineQuery(), params: { experimentId: experiment.id, started: '2026-11-01', from: '2026-11-16', cutoff: '2026-11-22', to: '2026-11-23' } },
        experimentResultsQuery([experiment], now),
      ];
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '2s'");
      for (const query of queries) {
        const sql = postgresQuery(query.sql, { ...query.params, tenantId: 'tenant', siteId: 'site', goal: 'lead' });
        const plan = await tx.$queryRawUnsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql.sql}`, ...sql.values);
        expect(JSON.stringify(plan)).toContain('events_conversion_session');
        const rows = await tx.$queryRawUnsafe<ImpactRow[]>(sql.sql, ...sql.values);
        expect(rows.map(row => [Number(row.exposures), Number(row.conversions)])).toEqual([[8000, 8000]]);
      }
    }, { timeout: 10000 });
  } finally {
    await prisma.$disconnect();
  }
}, 30000);
