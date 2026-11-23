import { analyzeExperiment } from './stats';
import type { EvaluationPlan } from '../experiments/experiment-evidence';

export interface TimelineRow { date: string | Date; variant_id: string; exposures: number | string; conversions: number | string }
export const CONVERSION_WINDOW_MS = 86_400_000;
export function timelineQuery() {
  return `WITH exposures AS (
    SELECT session_id, variant_id, min(event_time) AS first_exposure,
      count() OVER (PARTITION BY session_id) AS arms FROM events
    WHERE tenant_id = {tenantId:UUID} AND site_id = {siteId:UUID}
      AND experiment_id = {experimentId:UUID} AND event_name = 'exposure' AND is_bot = 0 AND session_id != ''
      AND event_time >= {started:DateTime64} AND event_time < {to:DateTime64}
    GROUP BY session_id, variant_id
  ), conversions AS (
    SELECT session_id, event_time AS converted_at FROM events
    WHERE tenant_id = {tenantId:UUID} AND site_id = {siteId:UUID} AND event_name = 'conversion' AND is_bot = 0
      AND event_time >= {from:DateTime64} AND event_time < {to:DateTime64} AND ({goal:String} = '' OR goal = {goal:String})
  ), attributed AS (
    SELECT e.session_id, e.variant_id, e.first_exposure,
      max(CASE WHEN c.converted_at >= e.first_exposure AND c.converted_at < e.first_exposure + INTERVAL 24 HOUR THEN 1 ELSE 0 END) AS converted
    FROM exposures e
    LEFT JOIN conversions c ON e.session_id = c.session_id
    WHERE e.arms = 1 AND e.first_exposure >= {from:DateTime64} AND e.first_exposure < {cutoff:DateTime64}
    GROUP BY e.session_id, e.variant_id, e.first_exposure
  ) SELECT CAST(first_exposure AS Date) AS date, variant_id, count() AS exposures, sum(converted) AS conversions
    FROM attributed GROUP BY date, variant_id ORDER BY date, variant_id`;
}

export function buildTimeline(variants: { id: string; name: string; isControl: boolean }[], rows: TimelineRow[], from: Date, cutoff: Date) {
  const totals = variants.map(variant => ({ variantId: variant.id, name: variant.name, isControl: variant.isControl, exposures: 0, conversions: 0 }));
  const days = new Map<string, TimelineRow[]>();
  for (const row of rows) {
    const date = new Date(row.date).toISOString().slice(0, 10);
    if (!days.has(date)) days.set(date, []);
    days.get(date)!.push(row);
  }
  const series: { date: string; variants: { variantId: string; exposures: number; conversions: number; conversionRate: number | null }[] }[] = [];
  for (let time = Date.parse(from.toISOString().slice(0, 10)); time < cutoff.getTime(); time += 86_400_000) {
    const date = new Date(time).toISOString().slice(0, 10);
    for (const row of days.get(date) ?? []) {
      const variant = totals.find(variant => variant.variantId === row.variant_id);
      if (variant) { variant.exposures += Number(row.exposures); variant.conversions += Number(row.conversions); }
    }
    series.push({ date, variants: totals.map(variant => ({ variantId: variant.variantId, exposures: variant.exposures, conversions: variant.conversions, conversionRate: variant.exposures ? variant.conversions / variant.exposures : null })) });
  }
  const analyzed = analyzeExperiment(totals);
  return { series, variants: analyzed.map((variant, index) => ({ ...variant, name: totals[index]!.name })) };
}

export interface ExperimentReport {
  version: 1; experimentId: string; experiment: { id: string; siteId: string; name: string; status: string };
  goal: { id: string; name: string } | null; plan: EvaluationPlan | null; conclusive: boolean; coverageComplete: boolean;
  recordedAt: string; conversionWindowHours: 24;
  variants: ReturnType<typeof buildTimeline>['variants']; series: ReturnType<typeof buildTimeline>['series'];
  evidence: { variantId: string; lower: number; upper: number; decision: string }[];
}

export function storedReport(value: unknown): ExperimentReport | null {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('variants' in value) || !Array.isArray(value.variants) || !('series' in value) || !Array.isArray(value.series) || !('conclusive' in value) || value.conclusive !== true) return null;
  const report = value as ExperimentReport;
  if (!report.experimentId || !report.experiment?.siteId || !report.coverageComplete || !report.series.length || !Number.isFinite(Date.parse(report.recordedAt))) return null;
  if (report.variants.filter(variant => variant.isControl).length !== 1 || !report.variants.some(variant => !variant.isControl)) return null;
  if (!report.variants.every(variant => Number.isSafeInteger(variant.exposures) && variant.exposures > 0 && Number.isSafeInteger(variant.conversions) && variant.conversions >= 0 && variant.conversions <= variant.exposures)) return null;
  return report;
}
