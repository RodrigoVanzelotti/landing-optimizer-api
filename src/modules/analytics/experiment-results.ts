import type { VariantStat } from './stats';
import { analyzeExperiment } from './stats';

export interface ResultExperiment {
  id: string; endedAt: Date | null; primaryGoal: { name: string } | null;
  startedAt?: Date | null; evaluationPlan?: unknown;
  variants: { id: string; name: string; isControl: boolean }[];
}
export interface ResultRow {
  experiment_id: string; variant_id: string; exposures: string | number; conversions: string | number;
}

export function experimentResultsQuery(experiments: ResultExperiment[], now = new Date()) {
  const params: Record<string, string> = {};
  const metadata = experiments.map((experiment, index) => {
    params[`experiment${index}`] = experiment.id;
    params[`goal${index}`] = experiment.primaryGoal?.name ?? '';
    params[`end${index}`] = (experiment.endedAt ?? now).toISOString().replace('T', ' ').replace('Z', '');
    const plan = experiment.evaluationPlan as { analysisFrom?: string } | null;
    params[`start${index}`] = (experiment.startedAt ?? new Date(0)).toISOString().replace('T', ' ').replace('Z', '');
    params[`from${index}`] = (plan?.analysisFrom ?? experiment.startedAt?.toISOString() ?? new Date(0).toISOString()).replace('T', ' ').replace('Z', '');
    return `SELECT {experiment${index}:UUID} AS experiment_id, {goal${index}:String} AS goal, {end${index}:DateTime64} AS ended_at, {start${index}:DateTime64} AS started_at, {from${index}:DateTime64} AS analysis_from`;
  }).join(' UNION ALL ');
  return { params, sql: `WITH metadata AS (${metadata}), exposures AS (
    SELECT e.experiment_id, e.session_id, e.variant_id, min(e.event_time) AS first_exposure
    FROM events e INNER JOIN metadata m ON e.experiment_id = m.experiment_id
    WHERE e.tenant_id = {tenantId:UUID} AND e.site_id = {siteId:UUID}
      AND e.event_name = 'exposure' AND e.is_bot = 0 AND e.session_id != ''
      AND e.event_time >= m.started_at AND e.event_time < m.ended_at
    GROUP BY e.experiment_id, e.session_id, e.variant_id
  ), assignments AS (
    SELECT experiment_id, session_id, count() AS arms FROM exposures GROUP BY experiment_id, session_id
  ), conversions AS (
    SELECT session_id, goal, event_time AS converted_at FROM events
    WHERE tenant_id = {tenantId:UUID} AND site_id = {siteId:UUID}
      AND event_name = 'conversion' AND is_bot = 0
  ), attributed AS (
    SELECT e.experiment_id, e.session_id, e.variant_id,
      max(CASE WHEN c.converted_at >= e.first_exposure AND c.converted_at <= m.ended_at
        AND c.converted_at < e.first_exposure + INTERVAL 24 HOUR
        AND (m.goal = '' OR c.goal = m.goal) THEN 1 ELSE 0 END) AS converted
    FROM exposures e INNER JOIN metadata m ON e.experiment_id = m.experiment_id
    INNER JOIN assignments a ON e.experiment_id = a.experiment_id AND e.session_id = a.session_id AND a.arms = 1
    LEFT JOIN conversions c ON e.session_id = c.session_id
    WHERE e.first_exposure >= m.analysis_from AND e.first_exposure < m.ended_at - INTERVAL 24 HOUR
    GROUP BY e.experiment_id, e.session_id, e.variant_id
  )
  SELECT experiment_id, variant_id, count() AS exposures, sum(converted) AS conversions
  FROM attributed GROUP BY experiment_id, variant_id` };
}

export function buildExperimentResults(experiments: ResultExperiment[], rows: ResultRow[]) {
  const byExperiment = new Map<string, Map<string, ResultRow>>();
  for (const row of rows) {
    if (!byExperiment.has(row.experiment_id)) byExperiment.set(row.experiment_id, new Map());
    byExperiment.get(row.experiment_id)!.set(row.variant_id, row);
  }
  return experiments.map(experiment => {
    const stats: VariantStat[] = experiment.variants.map(variant => {
      const row = byExperiment.get(experiment.id)?.get(variant.id);
      return { variantId: variant.id, isControl: variant.isControl, exposures: Number(row?.exposures ?? 0), conversions: Number(row?.conversions ?? 0) };
    });
    return { experimentId: experiment.id, variants: analyzeExperiment(stats).map((variant, index) => ({ ...variant, name: experiment.variants[index]!.name })) };
  });
}
