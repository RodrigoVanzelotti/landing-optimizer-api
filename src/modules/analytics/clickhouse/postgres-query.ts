// shortcut: translate only the analytics queries used here; use native SQL when retiring ClickHouse.
export function postgresQuery(sql: string, params: Record<string, unknown>) {
  const values: unknown[] = [];
  const translated = sql
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
