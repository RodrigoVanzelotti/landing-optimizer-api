import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import { postgresQuery } from '../src/modules/analytics/clickhouse/postgres-query';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = id(1), site = id(2), experimentId = id(3), control = id(4), variant = id(5);
const experiment = {
  tenantId: tenant, siteId: site, primaryGoal: { name: 'lead_received' },
  endedAt: new Date('2026-01-01T00:00:20Z'),
  variants: [{ id: control, isControl: true }, { id: variant, isControl: false }],
};

it('scopes both sides of attribution by site/tenant and binds the primary goal', async () => {
  const query = vi.fn().mockResolvedValue([{ variant_id: control, exposures: '2', conversions: '1' }]);
  const findUnique = vi.fn().mockResolvedValue(experiment);
  const service = new AnalyticsService({ experiment: { findUnique } } as never, { query } as never);
  const result = await service.experimentResults(tenant, experimentId);
  expect(findUnique).toHaveBeenCalledWith({ where: { id: experimentId }, include: { variants: true, primaryGoal: true } });
  const [sql, params] = query.mock.calls[0]!;
  expect((sql.match(/tenant_id = \{tenantId:UUID\} AND site_id = \{siteId:UUID\}/g) ?? []).length).toBe(2);
  expect(sql).toContain('AND goal = {goal:String}');
  expect(params).toEqual({ tenantId: tenant, siteId: site, experimentId, goal: 'lead_received', endedAt: '2026-01-01 00:00:20.000' });
  expect(result.variants[0]).toMatchObject({ exposures: 2, conversions: 1, conversionRate: 0.5 });
  expect(result.variants[1]).toMatchObject({ exposures: 0, conversions: 0 });
  findUnique.mockResolvedValue({ ...experiment, tenantId: id(9) });
  await expect(service.experimentResults(tenant, experimentId)).rejects.toThrow('Cross-tenant access');
  expect(query).toHaveBeenCalledTimes(1);
});

// Run with GOAL_SQL_INTEGRATION=1 against dedicated disposable Docker containers.
describe.skipIf(process.env.GOAL_SQL_INTEGRATION !== '1')('goal attribution on real analytics engines', () => {
  it.each(['postgres', 'clickhouse'])('deduplicates exposed sessions and attributes only subsequent matching goals on %s', async backend => {
    const container = `lo-goals-${backend}-check`;
    const sql = (statement: string) => execFileSync('docker', ['exec', '-i', container, ...(backend === 'postgres'
      ? ['psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tA']
      : ['clickhouse-client', '--multiquery'])], { input: statement, encoding: 'utf8', windowsHide: true });
    const quote = (value: unknown) => `'${String(value).replace(/'/g, "''")}'`;
    const time = (second: number) => `2026-01-01 00:00:${String(second).padStart(2, '0')}.000`;
    const rows: unknown[][] = [];
    const add = (session: string, v: string, event: string, second: number, goal = '', t = tenant, s = site, bot = 0) => {
      rows.push([t, s, session, experimentId, v, event, time(second), goal, bot]);
    };
    add('one', control, 'exposure', 10); add('one', control, 'exposure', 11);
    add('one', control, 'conversion', 12, 'lead_received'); add('one', control, 'conversion', 13, 'lead_received');
    add('two', control, 'conversion', 9, 'lead_received'); add('two', control, 'exposure', 10);
    add('two', control, 'conversion', 12, 'another_goal');
    add('three', variant, 'exposure', 10); add('three', variant, 'conversion', 11, 'lead_received');
    add('four', variant, 'exposure', 10); add('four', variant, 'conversion', 21, 'lead_received');
    add('two', control, 'conversion', 12, 'lead_received', id(8));
    add('two', control, 'conversion', 12, 'lead_received', tenant, id(9));
    add('two', control, 'conversion', 12, 'lead_received', tenant, site, 1);
    add('unexposed', variant, 'conversion', 12, 'lead_received');
    const text = backend === 'postgres' ? 'text' : 'String';
    const uuid = backend === 'postgres' ? 'text' : 'UUID';
    sql(`DROP TABLE IF EXISTS events; CREATE TABLE events (
      tenant_id ${uuid}, site_id ${uuid}, session_id ${text}, experiment_id ${uuid}, variant_id ${uuid},
      event_name ${text}, event_time ${backend === 'postgres' ? 'timestamp(3)' : 'DateTime64(3)'}, goal ${text}, is_bot ${backend === 'postgres' ? 'integer' : 'UInt8'}
    ) ${backend === 'postgres' ? '' : 'ENGINE = Memory'};
    INSERT INTO events VALUES ${rows.map(row => `(${row.map(quote).join(',')})`).join(',')};`);
    const service = new AnalyticsService({ experiment: { findUnique: vi.fn().mockResolvedValue(experiment) } } as never, {
      query: async (statement: string, params: Record<string, unknown>) => {
        let query: string;
        if (backend === 'postgres') {
          const translated = postgresQuery(statement, params);
          query = translated.sql.replace(/\$(\d+)::(text|timestamp)/g, (_, n, type) => `${quote(translated.values[Number(n) - 1])}::${type}`);
          query = `SELECT row_to_json(result) FROM (${query}) result;`;
        } else {
          query = statement.replace(/\{(\w+):(UUID|String|DateTime64)\}/g, (_, name, type) => type === 'UUID' ? `toUUID(${quote(params[name])})` : quote(params[name]));
          query += ' FORMAT JSONEachRow;';
        }
        return sql(query).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      },
    } as never);
    const result = await service.experimentResults(tenant, experimentId);
    for (const item of result.variants) expect(item).toMatchObject({ exposures: 2, conversions: 1, conversionRate: 0.5 });
  });
});
