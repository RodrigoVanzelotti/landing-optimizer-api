// shortcut: translate only the analytics queries used here; use native SQL when retiring ClickHouse.
export function postgresQuery(sql: string, params: Record<string, unknown>) {
  const values: unknown[] = [];
  const translated = sql
    // Keep session lookups parameterized even when PostgreSQL underestimates exposure counts.
    .replace(/LEFT JOIN conversions c ON e.session_id = c.session_id/g,
      'LEFT JOIN LATERAL (SELECT * FROM conversions WHERE session_id = e.session_id OFFSET 0) c ON true')
    .replace(/INTERVAL 24 HOUR/g, "INTERVAL '24 hours'")
    .replace(/count\(\)/g, 'count(*)')
    .replace(/countIf\(([^)]+)\)/g, 'count(*) FILTER (WHERE $1)')
    .replace(/sumIf\((\w+), ([^)]+)\)/g, 'coalesce(sum($1) FILTER (WHERE $2), 0)')
    .replace('(cta_clicks + dead_clicks + rage_clicks)', "count(*) FILTER (WHERE event_name IN ('cta_click', 'dead_click', 'rage_click'))")
    .replace(/\{(\w+):(UUID|String|DateTime64)\}/g, (_, name: string, type: string) => {
      if (!(name in params)) throw new Error(`Missing analytics parameter: ${name}`);
      values.push(params[name]);
      return `$${values.length}::${type === 'DateTime64' ? 'timestamp' : 'text'}`;
    });
  return { sql: translated, values };
}
