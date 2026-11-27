import { z } from 'zod';
import { looksLikePii } from '../events/event-scrub';

export const JOURNEY_WINDOW_MS = 30 * 60_000;
export const JOURNEY_ROW_LIMIT = 100_000;
export const journeyGoal = /^[a-zA-Z0-9_][a-zA-Z0-9_. -]{0,63}$/;
const eventName = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/;
const routePattern = /^\/(?!\/)[^?#[\]\\*\s]*(?:\/\*)?$/;
export function isJourneyRoute(route: string): boolean {
  try { return routePattern.test(route) && !looksLikePii(decodeURIComponent(route)); } catch { return false; }
}

export const JourneySchema = z.object({
  steps: z.array(z.string().trim().max(256)).max(8).default([]),
  globalEvent: z.object({ source: z.string().regex(eventName), goal: z.string().regex(journeyGoal) }).strict().optional(),
}).strict().superRefine(({ steps }, ctx) => {
  if (steps.length === 1 || new Set(steps).size !== steps.length ||
      steps.some((step, i) => looksLikePii(step) || !(isJourneyRoute(step) ||
        (i === steps.length - 1 && step.startsWith('event:') && journeyGoal.test(step.slice(6))))) ||
      steps.some(step => step.endsWith('/*') && steps.some(other => other !== step && other.startsWith(step.slice(0, -1))))) {
    ctx.addIssue({ code: 'custom', path: ['steps'], message: 'Use 2–8 distinct, non-overlapping paths, with an optional event as the final step.' });
  }
});
export type Journey = z.infer<typeof JourneySchema>;

export function readJourney(settings: unknown): Journey {
  return JourneySchema.safeParse((settings as { journey?: unknown } | null)?.journey ?? {}).data ?? { steps: [] };
}

export function matchesPath(pattern: string, path: string): boolean {
  return pattern.endsWith('/*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path;
}

export interface JourneyRow {
  session_id: string;
  event_time: string | Date;
  event_name: string;
  page_path: string;
  selector: string;
  goal: string;
  props: string;
}

export function buildJourney(journey: Journey, rows: JourneyRow[], cohortEnd: number) {
  const steps = journey.steps.map(rule => ({ rule, reached: 0, directEntries: 0 }));
  const transitions = steps.slice(1).map(() => ({
    unattributed: 0,
    ctas: new Map<string, { path: string; selector: string; group: string; clicked: number; arrived: number }>(),
  }));
  let cursor = 0;
  while (cursor < rows.length) {
    const session = rows[cursor]!.session_id;
    let stage = -1;
    let started = 0;
    let sawPage = false;
    let previousPath = '';
    let pending: { path: string; destination: string; key: string; at: number } | undefined;
    let clicked = new Set<string>();

    while (cursor < rows.length && rows[cursor]!.session_id === session) {
      const row = rows[cursor++]!;
      const at = row.event_time instanceof Date ? row.event_time.getTime() :
        Date.parse(row.event_time.replace(' ', 'T').replace(/Z?$/, 'Z'));
      if (!Number.isFinite(at)) continue;
      const next = steps[stage + 1];

      if (row.event_name === 'page_view' && !sawPage) {
        sawPage = true;
        const entry = steps.findIndex(step => matchesPath(step.rule, row.page_path));
        if (at < cohortEnd && entry > 0) steps[entry]!.directEntries++;
      }
      if (stage < 0) {
        if (row.event_name === 'page_view' && at < cohortEnd && next && matchesPath(next.rule, row.page_path)) {
          stage = 0;
          started = at;
          previousPath = row.page_path;
          next.reached++;
        }
        continue;
      }
      if (!next || at - started > JOURNEY_WINDOW_MS) continue;
      const transition = transitions[stage]!;
      if (row.event_name === 'navigation_click' && row.page_path === previousPath &&
          matchesPath(steps[stage]!.rule, previousPath)) {
        const { destination, group } = readClick(row.props);
        if (!matchesPath(next.rule, destination)) { pending = undefined; continue; }
        if (!group && !row.selector) { pending = undefined; continue; }
        const key = JSON.stringify(group ? ['group', group] : [row.page_path, row.selector]);
        const cta = transition.ctas.get(key) ?? {
          path: group ? '' : row.page_path, selector: group ? '' : row.selector, group, clicked: 0, arrived: 0,
        };
        if (!clicked.has(key)) { cta.clicked++; clicked.add(key); }
        transition.ctas.set(key, cta);
        // Ties between distinct clicks cannot establish which one was last.
        pending = pending?.at === at && pending.key !== key
          ? { path: row.page_path, destination, key: '', at }
          : { path: row.page_path, destination, key, at };
        continue;
      }
      const routeArrival = row.event_name === 'page_view' && matchesPath(next.rule, row.page_path);
      if (routeArrival || (row.event_name === 'conversion' && next.rule === 'event:' + row.goal)) {
        next.reached++;
        const attribution = routeArrival && pending && pending.at < at && pending.path === previousPath &&
          pending.destination === row.page_path && transition.ctas.get(pending.key);
        if (attribution) attribution.arrived++;
        else transition.unattributed++;
        stage++;
        clicked = new Set();
      }
      if (row.event_name === 'page_view') { previousPath = row.page_path; pending = undefined; }
    }
  }

  return steps.map((step, i) => {
    const transition = transitions[i - 1];
    const previous = steps[i - 1]?.reached;
    return {
      ...step,
      dropped: previous === undefined ? null : previous - step.reached,
      advanceRate: previous ? step.reached / previous : null,
      unattributed: transition?.unattributed ?? 0,
      ctas: [...(transition?.ctas.values() ?? [])].sort((a, b) => b.arrived - a.arrived || b.clicked - a.clicked).slice(0, 50),
    };
  });
}

function readClick(props: string): { destination: string; group: string } {
  try {
    const parsed = JSON.parse(props) as { destination?: unknown; group?: unknown } | null;
    return {
      destination: typeof parsed?.destination === 'string' ? parsed.destination : '',
      group: typeof parsed?.group === 'string' ? parsed.group : '',
    };
  } catch { return { destination: '', group: '' }; }
}
