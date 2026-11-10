import { describe, expect, it } from 'vitest';
import { postgresQuery } from '../src/modules/analytics/clickhouse/postgres-query';

describe('PostgreSQL analytics queries', () => {
  it('binds values separately and preserves tenant and date scopes', () => {
    const result = postgresQuery("SELECT count(), countIf(event_name = 'hover'), sumIf(dwell_ms, event_name = 'hover') FROM events WHERE tenant_id = {tenant:UUID} AND event_time >= {from:DateTime64}", { tenant: "x' OR true --", from: '2026-11-10' });
    expect(result.sql).toBe("SELECT count(*), count(*) FILTER (WHERE event_name = 'hover'), coalesce(sum(dwell_ms) FILTER (WHERE event_name = 'hover'), 0) FROM events WHERE tenant_id = $1::text AND event_time >= $2::timestamp");
    expect(result.values).toEqual(["x' OR true --", '2026-11-10']);
    expect(() => postgresQuery('{missing:UUID}', {})).toThrow('Missing analytics parameter');
  });
});
