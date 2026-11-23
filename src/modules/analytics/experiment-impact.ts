import { z } from 'zod';
import { ReportQuerySchema, reportRange } from './report';

export const ExperimentImpactQuerySchema = ReportQuerySchema.extend({ goalId: z.string().uuid() });
export type ExperimentImpactQuery = z.infer<typeof ExperimentImpactQuerySchema>;
export interface ImpactExperiment {
  id: string; name: string; status: string; startedAt: Date; endedAt: Date | null;
  variants: { id: string; isControl: boolean }[];
}
export interface ImpactRow {
  experiment_id: string; variant_id: string; exposure_date: string | Date;
  conversion_date: string | Date | null; exposures: string | number;
  conversions: string | number; excluded: string | number;
}
const DAY = 86_400_000;
const stamp = (value: string) => value.replace('T', ' ').replace('Z', '');

/** Metadata is supplied by the authorized PostgreSQL read, never by the caller. */
export function impactQuery(experiments: ImpactExperiment[], range: ReturnType<typeof reportRange>, availableFrom: string) {
  const params: Record<string, unknown> = {
    from: stamp(range.from), to: stamp(range.to),
    previousFrom: stamp(range.previousFrom > availableFrom ? range.previousFrom : availableFrom),
  };
  const metadata = experiments.map((experiment, index) => {
    params[`experiment${index}`] = experiment.id;
    params[`start${index}`] = stamp(experiment.startedAt.toISOString());
    params[`end${index}`] = stamp(experiment.endedAt && experiment.endedAt.toISOString() < range.to ? experiment.endedAt.toISOString() : range.to);
    return `SELECT {experiment${index}:String} AS experiment_id, {start${index}:DateTime64} AS started_at, {end${index}:DateTime64} AS ended_at`;
  }).join(' UNION ALL ');
  return { params, sql: `WITH metadata AS (${metadata}), exposures AS (
    SELECT session_id, experiment_id, variant_id, min(event_time) AS first_exposure,
      count() OVER (PARTITION BY session_id) AS assignment_count
    FROM events WHERE tenant_id = {tenantId:UUID} AND site_id = {siteId:UUID}
      AND event_time >= {previousFrom:DateTime64} AND event_time < {to:DateTime64}
      AND event_name = 'exposure' AND is_bot = 0 AND session_id != ''
    GROUP BY session_id, experiment_id, variant_id
  ), conversions AS (
    SELECT session_id, event_time AS converted_at FROM events
    WHERE tenant_id = {tenantId:UUID} AND site_id = {siteId:UUID}
      AND event_time >= {previousFrom:DateTime64} AND event_time < {to:DateTime64}
      AND event_name = 'conversion' AND goal = {goal:String} AND is_bot = 0 AND session_id != ''
  ), attributed AS (
    SELECT e.session_id, e.experiment_id, e.variant_id, e.first_exposure, e.assignment_count,
      min(CASE WHEN c.converted_at >= e.first_exposure AND c.converted_at < m.ended_at
        AND c.converted_at < CASE WHEN e.first_exposure < {from:DateTime64} THEN {from:DateTime64} ELSE {to:DateTime64} END
        THEN c.converted_at ELSE {to:DateTime64} END) AS first_conversion
    FROM exposures e INNER JOIN metadata m ON e.experiment_id = m.experiment_id
    LEFT JOIN conversions c ON e.session_id = c.session_id
    WHERE e.first_exposure >= m.started_at AND e.first_exposure < m.ended_at
    GROUP BY e.session_id, e.experiment_id, e.variant_id, e.first_exposure, e.assignment_count
  )
  SELECT experiment_id, variant_id, CAST(first_exposure AS DATE) AS exposure_date,
    CASE WHEN first_conversion < {to:DateTime64} THEN CAST(first_conversion AS DATE) ELSE NULL END AS conversion_date,
    sum(CASE WHEN assignment_count = 1 THEN 1 ELSE 0 END) AS exposures,
    sum(CASE WHEN assignment_count = 1 AND first_conversion < {to:DateTime64} THEN 1 ELSE 0 END) AS conversions,
    sum(CASE WHEN assignment_count > 1 THEN 1 ELSE 0 END) AS excluded
  FROM attributed GROUP BY experiment_id, variant_id, exposure_date, conversion_date` };
}

function counts() { return { exposures: 0, conversions: 0 }; }
function totals() { return { control: counts(), variants: counts() }; }
function summarize(value: ReturnType<typeof totals>) {
  const controlRate = value.control.exposures ? value.control.conversions / value.control.exposures : null;
  const variantRate = value.variants.exposures ? value.variants.conversions / value.variants.exposures : null;
  return { control: { ...value.control, rate: controlRate }, variants: { ...value.variants, rate: variantRate }, gainPp: controlRate !== null && variantRate !== null ? (variantRate - controlRate) * 100 : null };
}
const day = (value: string | Date) => new Date(value).toISOString().slice(0, 10);

/** Conversion counts enter the curve on conversion day, never retroactively. */
export function buildExperimentImpact(timeframe: ExperimentImpactQuery['timeframe'], range: ReturnType<typeof reportRange>, availableFrom: string, experiments: ImpactExperiment[], rows: ImpactRow[]) {
  const current = totals(), previous = totals();
  const byDay = new Map<string, ReturnType<typeof totals>>();
  const byExperiment = new Map(experiments.map(experiment => [experiment.id, totals()]));
  const metadata = new Map(experiments.map(experiment => [experiment.id, experiment]));
  let excludedExposures = 0;
  for (const row of rows) {
    const experiment = metadata.get(row.experiment_id);
    const variant = experiment?.variants.find(item => item.id === row.variant_id);
    if (!variant) continue;
    const date = day(row.exposure_date);
    if (date < range.previousFrom.slice(0, 10) || date >= range.to.slice(0, 10)) continue;
    const inCurrent = date >= range.from.slice(0, 10);
    const period = inCurrent ? current : previous;
    const group = variant.isControl ? 'control' : 'variants';
    const exposures = Number(row.exposures), conversions = Number(row.conversions);
    period[group].exposures += exposures;
    period[group].conversions += conversions;
    if (!inCurrent) continue;
    excludedExposures += Number(row.excluded);
    const daily = byDay.get(date) ?? totals();
    daily[group].exposures += exposures;
    byDay.set(date, daily);
    if (row.conversion_date) {
      const converted = day(row.conversion_date);
      const conversionDay = byDay.get(converted) ?? totals();
      conversionDay[group].conversions += conversions;
      byDay.set(converted, conversionDay);
    }
    const total = byExperiment.get(row.experiment_id)!;
    total[group].exposures += exposures; total[group].conversions += conversions;
  }
  const series = [];
  const cumulative = totals();
  const step = timeframe === '7d' || timeframe === '30d' ? DAY : 7 * DAY;
  for (let time = Date.parse(range.from); time < Date.parse(range.to); time += step) {
    const end = Math.min(time + step, Date.parse(range.to));
    for (let date = time; date < end; date += DAY) {
      const daily = byDay.get(new Date(date).toISOString().slice(0, 10));
      if (daily) for (const group of ['control', 'variants'] as const) {
        cumulative[group].exposures += daily[group].exposures;
        cumulative[group].conversions += daily[group].conversions;
      }
    }
    const covered = time >= Date.parse(availableFrom);
    series.push({ from: new Date(time).toISOString(), to: new Date(end).toISOString(), values: covered ? summarize(cumulative) : null });
  }
  return {
    timeframe, range, timezone: 'UTC' as const,
    coverage: { availableFrom, currentComplete: range.from >= availableFrom, previousComplete: range.previousFrom >= availableFrom },
    current: summarize(current), previous: summarize(previous), series, excludedExposures,
    experiments: experiments.map(experiment => ({
      id: experiment.id, name: experiment.name, status: experiment.status,
      startedAt: experiment.startedAt.toISOString(), endedAt: experiment.endedAt?.toISOString() ?? null,
      partial: experiment.status === 'running' || experiment.status === 'paused',
      ...summarize(byExperiment.get(experiment.id)!),
    })),
  };
}
