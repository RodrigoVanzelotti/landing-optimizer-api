import { describe, expect, it, vi } from 'vitest';
import { EventsService } from '../src/modules/events/events.service';
import { EnvelopeSchema } from '../src/modules/events/event-scrub';
import { matchesGoal } from '../src/modules/goals/goal-matcher';
import type { EventRow } from '../src/modules/analytics/clickhouse/clickhouse.service';

const siteId = '018f6b2a-0000-7000-8000-000000000000';
const selector = '[data-lo-id="lead-form"]';
const row = (event_name = 'page_view', page_path = '/thank-you?private=discarded#done', sel = selector) =>
  ({ event_name, page_path, selector: sel }) as EventRow;

describe('automatic goal matching', () => {
  it.each([
    ['exact', '/thank-you', true], ['exact', '/thank', false],
    ['prefix', '/thank', true], ['contains', 'thank-', true],
    ['regex', '^/thank-you$', true], ['regex', '^/other$', false],
    ['regex', '(', false], ['unknown', '/', false],
  ])('matches URL %s %s: %s', (op, path, expected) => {
    expect(matchesGoal({ kind: 'url', matcher: { op, path } }, row())).toBe(expected);
    expect(matchesGoal({ kind: 'url', matcher: { op, path } }, row('cta_click'))).toBe(false);
  });

  it('bounds catastrophic regex execution', () => {
    expect(matchesGoal({ kind: 'url', matcher: { op: 'regex', path: '(a+)+$' } }, row('page_view', '/'+ 'a'.repeat(500) + '!'))).toBe(false);
  });

  it('matches only native form submissions and respects exact selectors', () => {
    const goal = { kind: 'form_submit' as const, matcher: { selector } };
    expect(matchesGoal(goal, row('form_submit'))).toBe(true);
    expect(matchesGoal(goal, row('form_submit', '/', '#another'))).toBe(false);
    expect(matchesGoal(goal, row('cta_click'))).toBe(false);
    expect(matchesGoal({ kind: 'form_submit', matcher: {} }, row('form_submit'))).toBe(true);
    expect(matchesGoal({ kind: 'form_submit', matcher: { selector: 'input[value="private"]' } }, row('form_submit'))).toBe(false);
    expect(matchesGoal({ kind: 'event', matcher: {} }, row('conversion'))).toBe(false);
  });
});

describe('goal ingestion', () => {
  function setup(goals: object[] = []) {
    const findMany = vi.fn().mockResolvedValue(goals);
    const insertEvents = vi.fn().mockResolvedValue(undefined);
    const service = new EventsService(
      { conversionGoal: { findMany } } as never,
      { allow: vi.fn().mockResolvedValue(true) } as never,
      { insertEvents } as never,
      { resolveSite: vi.fn().mockResolvedValue({ active: true, siteId, tenantId: siteId }),
        originAllowed: () => true, hash: () => 'hash', dailySalt: () => 'salt', pseudoSession: () => 'opaque' } as never,
    );
    return { service, findMany, insertEvents };
  }
  const envelope = (events: object[]) => EnvelopeSchema.parse({ v: 1, siteId, ik: 'test', sid: 'session', ctx: { path: '/thank-you?private=x' }, events });

  it('preserves source events and persists matching conversions once per rule and occurrence', async () => {
    const { service, findMany, insertEvents } = setup([
      { name: 'thanks', kind: 'url', matcher: { path: '/thank-you' } },
      { name: 'submit', kind: 'form_submit', matcher: { selector } },
    ]);
    await service.ingest(envelope([
      { n: 'exposure', t: 1, exp: siteId, var: siteId },
      { n: 'page_view', t: 2 }, { n: 'form_submit', t: 3, sel: selector },
      { n: 'conversion', t: 4, goal: 'lead_received' },
    ]), 'https://client.example', undefined);
    expect(findMany).toHaveBeenCalledWith({ where: { siteId, site: { tenantId: siteId }, kind: { in: ['url', 'form_submit'] } } });
    const rows = insertEvents.mock.calls[0]![0] as EventRow[];
    expect(rows).toHaveLength(6);
    expect(rows.filter(e => e.event_name === 'conversion').map(e => e.goal)).toEqual(['lead_received', 'thanks', 'submit']);
    expect(rows[0]!.event_time < rows[1]!.event_time).toBe(true);
    expect(rows[4]!.event_time).toBe(rows[1]!.event_time);
    expect(rows[5]!.selector).toBe(selector);
    expect(rows.every(e => e.page_path === '/thank-you' && e.session_id === 'opaque')).toBe(true);
  });

  it('keeps explicit conversion events without synthesizing duplicates', async () => {
    const { service, findMany, insertEvents } = setup();
    await service.ingest(envelope([{ n: 'conversion', t: 0, goal: 'lead_received' }]), undefined, undefined);
    expect(findMany).not.toHaveBeenCalled();
    expect(insertEvents.mock.calls[0]![0]).toHaveLength(1);
  });

  it('does not acknowledge or partially insert events when rule loading fails', async () => {
    const { service, findMany, insertEvents } = setup();
    findMany.mockRejectedValue(new Error('database unavailable'));
    await expect(service.ingest(envelope([{ n: 'page_view', t: 0 }]), undefined, undefined)).rejects.toThrow('Event storage unavailable');
    expect(insertEvents).not.toHaveBeenCalled();
  });
});
