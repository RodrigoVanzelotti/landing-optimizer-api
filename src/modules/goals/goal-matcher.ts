import { runInNewContext } from 'node:vm';
import type { ConversionGoal } from '@prisma/client';
import { sanitizePath, sanitizeSelector } from '../events/event-scrub';
import type { EventRow } from '../analytics/clickhouse/clickhouse.service';

export function matchesGoal(goal: Pick<ConversionGoal, 'kind' | 'matcher'>, row: EventRow): boolean {
  const matcher = goal.matcher as { op?: string; path?: string; selector?: string };
  if (goal.kind === 'form_submit') {
    return row.event_name === 'form_submit' && (!matcher.selector || (
      sanitizeSelector(matcher.selector) !== '' && row.selector === matcher.selector
    ));
  }
  if (goal.kind !== 'url' || row.event_name !== 'page_view' || !matcher.path) return false;
  const path = sanitizePath(row.page_path);
  switch (matcher.op ?? 'exact') {
    case 'exact': return path === matcher.path;
    case 'prefix': return path.startsWith(matcher.path);
    case 'contains': return path.includes(matcher.path);
    case 'regex':
      try {
        // Bound configured regex execution so a pathological pattern cannot stall ingestion.
        return runInNewContext('new RegExp(pattern).test(path)', { pattern: matcher.path, path }, {
          timeout: 25, contextCodeGeneration: { strings: false, wasm: false },
        }) === true;
      } catch { return false; }
    default: return false;
  }
}
