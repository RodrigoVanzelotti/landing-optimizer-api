import { z } from 'zod';

export const SiteQuerySchema = z.object({ siteId: z.string().uuid() });
export const AnalyticsRangeQuerySchema = SiteQuerySchema.extend({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  path: z.string().max(512).default('/'),
}).transform((query, ctx) => {
  const to = query.to ?? new Date().toISOString();
  const from = query.from ?? new Date(Date.parse(to) - 30 * 864e5).toISOString();
  const duration = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(duration) || duration < 0 || duration > 366 * 864e5) {
    ctx.addIssue({ code: 'custom', message: 'Analytics range must be ordered and at most 366 days' });
    return z.NEVER;
  }
  return { ...query, from, to };
});
export type AnalyticsRangeQuery = z.infer<typeof AnalyticsRangeQuerySchema>;

export const ReportQuerySchema = z.object({
  siteId: z.string().uuid(),
  timeframe: z.enum(['7d', '30d', '6m', '1y']).default('30d'),
});
export type ReportQuery = z.infer<typeof ReportQuerySchema>;

const DAY = 864e5;
export function reportRange(timeframe: ReportQuery['timeframe'], now = new Date()) {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to);
  if (timeframe === '7d' || timeframe === '30d') {
    from.setUTCDate(from.getUTCDate() - (timeframe === '7d' ? 7 : 30));
  } else {
    from.setUTCDate(1);
    from.setUTCMonth(from.getUTCMonth() - (timeframe === '6m' ? 6 : 12));
    const lastDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0)).getUTCDate();
    from.setUTCDate(Math.min(to.getUTCDate(), lastDay));
  }
  return {
    from: from.toISOString(), to: to.toISOString(),
    previousFrom: new Date(from.getTime() - (to.getTime() - from.getTime())).toISOString(),
    previousTo: from.toISOString(),
  };
}

export interface ReportMetrics {
  pageViews: number; sessions: number; ctaClicks: number; conversions: number;
  formSubmits: number; formStarts: number; formCompletions: number;
  formCompletionRate: number | null;
}
export interface DailyMetric { date: string | Date; metric: string; count: string | number | bigint }
export interface ReportSection { section: string; views: number; deadClicks: number; rageClicks: number; dwellMs: number }

type CountKey = Exclude<keyof ReportMetrics, 'formCompletionRate'>;
const eventKeys = new Map<string, CountKey>([['page_view', 'pageViews'], ['cta_click', 'ctaClicks'], ['conversion', 'conversions'], ['form_submit', 'formSubmits']]);
const sessionKeys = new Map<string, CountKey>([['sessions', 'sessions'], ['formStarts', 'formStarts'], ['formCompletions', 'formCompletions']]);
function emptyMetrics(): ReportMetrics {
  return { pageViews: 0, sessions: 0, ctaClicks: 0, conversions: 0, formSubmits: 0, formStarts: 0, formCompletions: 0, formCompletionRate: null };
}
function completionRate(metrics: ReportMetrics) {
  metrics.formCompletionRate = metrics.formStarts ? metrics.formCompletions / metrics.formStarts : null;
  return metrics;
}

/** Aggregate daily counts into equal-duration, aligned current/previous buckets. */
export function buildReport(
  timeframe: ReportQuery['timeframe'], range: ReturnType<typeof reportRange>, availableFrom: string,
  eventRows: DailyMetric[], sessionRows: DailyMetric[], sections: ReportSection[],
) {
  const daily = new Map<string, ReportMetrics>();
  const events = new Map<string, number>();
  for (const [rows, keys] of [[eventRows, eventKeys], [sessionRows, sessionKeys]] as const) {
    for (const row of rows) {
      const date = new Date(row.date).toISOString().slice(0, 10);
      const metrics = daily.get(date) ?? emptyMetrics();
      const key = keys.get(row.metric);
      if (key) metrics[key] += Number(row.count);
      daily.set(date, metrics);
      if (rows === eventRows && date >= range.from.slice(0, 10) && date < range.to.slice(0, 10)) {
        events.set(row.metric, (events.get(row.metric) ?? 0) + Number(row.count));
      }
    }
  }
  function sum(from: number, to: number) {
    const total = emptyMetrics();
    for (let time = from; time < to; time += DAY) {
      const row = daily.get(new Date(time).toISOString().slice(0, 10));
      if (row) for (const key of ['pageViews', 'sessions', 'ctaClicks', 'conversions', 'formSubmits', 'formStarts', 'formCompletions'] as const) total[key] += row[key];
    }
    return completionRate(total);
  }
  const from = Date.parse(range.from), to = Date.parse(range.to), previousFrom = Date.parse(range.previousFrom);
  const step = timeframe === '7d' || timeframe === '30d' ? DAY : 7 * DAY;
  const series = [];
  for (let time = from; time < to; time += step) {
    const end = Math.min(time + step, to);
    const previous = previousFrom + time - from;
    series.push({
      from: new Date(time).toISOString(), to: new Date(end).toISOString(),
      previousFrom: new Date(previous).toISOString(), previousTo: new Date(previous + end - time).toISOString(),
      current: time >= Date.parse(availableFrom) ? sum(time, end) : null,
      previous: previous >= Date.parse(availableFrom) ? sum(previous, previous + end - time) : null,
    });
  }
  return {
    timeframe, range, timezone: 'UTC', granularity: step === DAY ? 'day' as const : 'week' as const,
    coverage: { availableFrom, currentComplete: range.from >= availableFrom, previousComplete: range.previousFrom >= availableFrom },
    current: sum(from, to), previous: sum(previousFrom, from), series,
    events: [...events].map(([event, count]) => ({ event, count })).sort((a, b) => b.count - a.count), sections,
  };
}

// Match the same form on the same page, after its start; never expose session IDs.
export const SESSION_REPORT_SQL = `WITH scoped AS (
  SELECT session_id, event_name, event_time, selector, page_path,
         CASE WHEN event_time >= {from:DateTime64} THEN 1 ELSE 0 END AS period
  FROM events
  WHERE tenant_id = {tenantId:UUID} AND site_id = {siteId:UUID}
    AND event_time >= {previousFrom:DateTime64} AND event_time < {to:DateTime64}
    AND is_bot = 0 AND session_id != ''
), visits AS (
  SELECT period, session_id, min(event_time) AS visited_at
  FROM scoped WHERE event_name = 'page_view' GROUP BY period, session_id
), starts AS (
  SELECT period, session_id, selector, page_path, min(event_time) AS started_at
  FROM scoped WHERE event_name = 'form_start' AND selector != ''
  GROUP BY period, session_id, selector, page_path
), completions AS (
  SELECT s.period, s.session_id, s.started_at
  FROM starts s INNER JOIN scoped e ON s.period = e.period AND s.session_id = e.session_id
    AND s.selector = e.selector AND s.page_path = e.page_path
  WHERE e.event_name = 'form_submit' AND e.event_time >= s.started_at
  GROUP BY s.period, s.session_id, s.started_at
), activity AS (
  SELECT period, session_id, started_at, 0 AS completed FROM starts
  UNION ALL SELECT period, session_id, started_at, 1 AS completed FROM completions
), forms AS (
  SELECT period, session_id, min(started_at) AS started_at, max(completed) AS completed
  FROM activity GROUP BY period, session_id
)
SELECT CAST(visited_at AS DATE) AS date, 'sessions' AS metric, count() AS count FROM visits GROUP BY date
UNION ALL
SELECT CAST(started_at AS DATE) AS date, 'formStarts' AS metric, count() AS count FROM forms GROUP BY date
UNION ALL
SELECT CAST(started_at AS DATE) AS date, 'formCompletions' AS metric, sum(completed) AS count FROM forms GROUP BY date`;
