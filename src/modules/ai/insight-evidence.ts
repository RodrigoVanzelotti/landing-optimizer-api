import { z } from 'zod';
import type { AnalyticsService } from '../analytics/analytics.service';
import { sanitizeSelector } from '../events/event-scrub';

export const InsightReferencesSchema = z.object({
  kpiKeys: z.array(z.string().min(1).max(128)).max(6)
    .refine(keys => new Set(keys).size === keys.length, 'Duplicate KPI references').nullish().transform(value => value ?? undefined).optional(),
  designContext: z.object({
    selector: z.string().min(1).max(256).refine(value => sanitizeSelector(value) === value, 'Unsafe design selector'),
    observation: z.string().max(2000).nullish().transform(value => value ?? undefined).optional(),
  }).nullish().transform(value => value ?? undefined).optional(),
});
export type InsightReferences = z.infer<typeof InsightReferencesSchema>;
type Report = Awaited<ReturnType<AnalyticsService['report']>>;

export interface InsightKpi {
  key: string;
  label: string;
  value: number | null;
  unit: 'count' | 'ratio' | 'milliseconds';
  definition: string;
  previousValue?: number | null;
  numerator?: number;
  denominator?: number;
}

export function insightKpis(report: Report): InsightKpi[] {
  const current = report.current, previous = report.previous;
  type CountKey = Exclude<keyof typeof current, 'formCompletionRate'>;
  const comparable = report.coverage.currentComplete && report.coverage.previousComplete;
  const count = (key: CountKey, label: string, definition: string): InsightKpi => ({
    key, label, value: current[key], unit: 'count', definition,
    ...(comparable ? { previousValue: previous[key] } : {}),
  });
  const ratio = (key: string, label: string, numerator: CountKey, denominator: CountKey, definition: string): InsightKpi => ({
    key, label, unit: 'ratio', definition,
    value: current[denominator] ? current[numerator] / current[denominator] : null,
    numerator: current[numerator], denominator: current[denominator],
    ...(comparable ? { previousValue: previous[denominator] ? previous[numerator] / previous[denominator] : null } : {}),
  });
  const kpis: InsightKpi[] = [
    count('pageViews', 'Visualizações', 'Quantidade de eventos de visualização de página.'),
    count('sessions', 'Sessões', 'Sessões com visualização de página no período.'),
    count('ctaClicks', 'Cliques em CTA', 'Eventos de clique em chamadas para ação; uma sessão pode clicar mais de uma vez.'),
    count('conversions', 'Conversões', 'Eventos de conversão; uma sessão pode converter mais de uma vez.'),
    count('formStarts', 'Inícios de formulário', 'Sessões que iniciaram uma jornada de formulário.'),
    count('formCompletions', 'Formulários concluídos', 'Sessões com início e posterior envio do mesmo formulário e página. Não confirma aceitação pelo servidor.'),
    ratio('ctaClicksPerView', 'Cliques em CTA / visualização', 'ctaClicks', 'pageViews', 'Cliques em CTA divididos por visualizações; não representa uma taxa de visitantes únicos e pode superar 100%.'),
    ratio('conversionsPerView', 'Conversões / visualização', 'conversions', 'pageViews', 'Eventos de conversão divididos por visualizações; não representa uma taxa de visitantes únicos e pode superar 100%.'),
    ratio('formCompletionRate', 'Taxa de conclusão de formulários', 'formCompletions', 'formStarts', 'Sessões que concluíram a jornada divididas pelas sessões que iniciaram o formulário.'),
  ];
  for (const section of report.sections) {
    for (const [key, label, definition] of [
      ['views', 'Visualizações da seção', 'Eventos de visualização desta seção.'],
      ['deadClicks', 'Cliques sem resposta', 'Eventos de clique sem resposta observados nesta seção.'],
      ['rageClicks', 'Cliques repetidos', 'Eventos de clique repetido observados nesta seção.'],
      ['dwellMs', 'Atenção acumulada', 'Tempo de atenção acumulado nesta seção, em milissegundos; não é uma média.'],
    ] as const) kpis.push({ key: `section:${section.section}:${key}`, label: `${label} · ${section.section}`, value: section[key], unit: key === 'dwellMs' ? 'milliseconds' : 'count', definition });
  }
  return kpis;
}

const PageMapSchema = z.object({ nodes: z.array(z.object({
  selector: z.string(), text: z.string().nullish(), tag: z.string().nullish(), role: z.string().nullish(),
})) });

export function resolveInsightEvidence(
  references: InsightReferences, report: Report, kpis: InsightKpi[],
  pageMap: { map: unknown; urlPath: string; capturedAt: Date } | null,
) {
  const selected = (references.kpiKeys ?? []).map(key => {
    const kpi = kpis.find(item => item.key === key);
    if (!kpi) throw new Error('Unknown KPI reference');
    return kpi;
  });
  let designContext;
  if (references.designContext) {
    const context = references.designContext;
    const parsed = PageMapSchema.safeParse(pageMap?.map);
    const node = parsed.success ? parsed.data.nodes.find(item => item.selector === context.selector) : undefined;
    if (!node || !pageMap) throw new Error('Unknown design reference');
    designContext = {
      selector: node.selector, pagePath: pageMap.urlPath, capturedAt: pageMap.capturedAt.toISOString(),
      ...(node.text ? { text: node.text } : {}), ...(node.tag ? { tag: node.tag } : {}),
      ...(node.role ? { role: node.role } : {}),
      ...(context.observation ? { observation: context.observation } : {}),
    };
  }
  return {
    analysisPeriod: {
      from: report.range.from, to: report.range.to, timezone: 'UTC' as const,
      observedFrom: report.range.from > report.coverage.availableFrom ? report.range.from : report.coverage.availableFrom,
      partial: !report.coverage.currentComplete,
      sessions: report.current.sessions, pageViews: report.current.pageViews,
      ...(report.coverage.currentComplete && report.coverage.previousComplete ? { comparison: { from: report.range.previousFrom, to: report.range.previousTo } } : {}),
    },
    ...(selected.length ? { kpis: selected } : {}),
    ...(designContext ? { designContext } : {}),
  };
}
