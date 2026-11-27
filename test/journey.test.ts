import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { buildJourney, JourneySchema, JOURNEY_WINDOW_MS, type JourneyRow } from '../src/modules/analytics/journey';
import { matchesGoal } from '../src/modules/goals/goal-matcher';
import type { EventRow } from '../src/modules/analytics/clickhouse/clickhouse.service';
import { ClickHouseService } from '../src/modules/analytics/clickhouse/clickhouse.service';
import { EventsService } from '../src/modules/events/events.service';
import { SiteAuthService } from '../src/modules/events/site-auth.service';

const start = Date.parse('2026-11-27T10:00:00Z');
const event = (session_id: string, offset: number, page_path: string, extra: Partial<JourneyRow> = {}): JourneyRow => ({
  session_id, event_time: new Date(start + offset), page_path, event_name: 'page_view',
  selector: '', props: '', goal: '', ...extra,
});
const click = (session: string, offset: number, selector: string, destination: string) =>
  event(session, offset, '/', { event_name: 'navigation_click', selector, props: JSON.stringify({ destination }) });

describe('site journey', () => {
  it('attributes only the observed destination and reports direct entries and drop-off separately', () => {
    const journey = JourneySchema.parse({ steps: ['/', '/cadastro', 'event:signup'] });
    const report = buildJourney(journey, [
      event('a', 0, '/'),
      click('a', 2, '#top', '/cadastro'),
      click('a', 4, '#hero', '/cadastro'),
      event('a', 6, '/cadastro'),
      event('a', 7, '/cadastro'),
      event('a', 8, '/cadastro', { event_name: 'conversion', goal: 'signup' }),
      event('b', 0, '/cadastro'),
      event('c', 1, '/'),
      click('c', 4, '#top', '/cadastro'),
      event('c', JOURNEY_WINDOW_MS + 2, '/cadastro'),
      event('d', 1, '/'),
      click('d', 3, '#hero', '/cadastro'),
      event('d', 6, '/other'),
      event('d', 8, '/cadastro'),
    ], start + 60_000);
    expect(report.map(x => [x.reached, x.dropped, x.directEntries, x.unattributed])).toEqual([
      [3, null, 0, 0], [2, 1, 1, 1], [1, 1, 0, 1],
    ]);
    expect(report[1]?.ctas).toMatchObject([
      { selector: '#hero', clicked: 2, arrived: 1 }, { selector: '#top', clicked: 2, arrived: 0 },
    ]);
  });

  it('accepts reusable route families and rejects overlapping steps and unsafe paths', () => {
    expect(JourneySchema.safeParse({ steps: ['/produto/*', '/checkout'] }).success).toBe(true);
    for (const steps of [['/produto/*', '/produto/a'], ['/a?token=aaa', '/b'], ['//outside', '/b'],
      ['/a%40example.com', '/b'], ['event:signup', '/b']]) {
      expect(JourneySchema.safeParse({ steps }).success).toBe(false);
    }
  });

  it('makes a route goal conditional on an observed previous path', () => {
    const goal = { kind: 'url' as const, matcher: { path: '/checkout', fromPath: '/produto/*' } };
    const row = { event_name: 'page_view', page_path: '/checkout' } as EventRow;
    expect(matchesGoal(goal, row)).toBe(false);
    expect(matchesGoal(goal, row, { n: 'page_view', t: 1, p: { previousPath: '/produto/a' } })).toBe(true);
    expect(matchesGoal(goal, row, { n: 'page_view', t: 1, p: { previousPath: '/checkout' } })).toBe(false);
  });

  it('records a server conversion once and rejects a credential belonging to another site', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'site' }]),
      $executeRaw: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(0),
    };
    const prisma = {
      $transaction: async (run: (client: typeof tx) => unknown) => run(tx),
      site: { findFirst: vi.fn().mockResolvedValue({ tenantId: 'tenant' }) },
      conversionGoal: { findFirst: vi.fn().mockResolvedValue({ id: 'goal' }) },
      $queryRaw: vi.fn().mockResolvedValue([{ session_id: 'observed-session' }]),
    };
    const config = new ConfigService({ ANALYTICS_BACKEND: 'postgres', JWT_SECRET: 'test' });
    const siteAuth = new SiteAuthService(prisma as never, config as never);
    const storage = new ClickHouseService(config as never, prisma as never);
    const events = new EventsService(prisma as never, {} as never, storage, siteAuth);
    const conversion = { goal: 'purchase', transactionId: 'order-7', sessionId: 's_' + 'a'.repeat(32) };
    await expect(events.serverConversion('site', `Bearer ${siteAuth.serverToken('other')}`, conversion)).rejects.toMatchObject({ status: 403 });
    await expect(events.serverConversion('site', `Bearer ${siteAuth.serverToken('site')}`, conversion))
      .resolves.toEqual({ recorded: true, attributed: true });
    await expect(events.serverConversion('site', `Bearer ${siteAuth.serverToken('site')}`, conversion))
      .resolves.toEqual({ recorded: false, attributed: false });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    expect(JSON.parse(tx.$executeRaw.mock.calls[1]![1] as string)[0]).toMatchObject({
      session_id: 'observed-session', goal: 'purchase', props: '',
    });
  });
});
