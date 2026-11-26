import { runInNewContext } from 'node:vm';
import type { ConversionGoal } from '@prisma/client';
import { sanitizePath, sanitizeSelector } from '../events/event-scrub';
import type { WireEvent } from '../events/event-scrub';
import type { ElementVisibleMatcher } from './goals.dto';
import type { EventRow } from '../analytics/clickhouse/clickhouse.service';

export function matchesGoal(goal: Pick<ConversionGoal, 'kind' | 'matcher'>, row: EventRow, source?: WireEvent): boolean {
  if (goal.kind === 'element_visible') {
    const { path, selector, formSelector } = goal.matcher as ElementVisibleMatcher;
    return row.event_name === 'element_visible' && row.page_path === path &&
      row.selector === selector && source?.p?.formSelector === formSelector;
  }
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
