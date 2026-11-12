import { describe, expect, it, vi } from 'vitest';
import { EnvelopeSchema, parsePageMapPayload, sanitizeSelector } from '../src/modules/events/event-scrub';
import { EventsService } from '../src/modules/events/events.service';
import { CreateExperimentSchema } from '../src/modules/experiments/experiments.dto';
import { SnapshotEnvelopeSchema } from '../src/modules/snapshots/snapshots.dto';

const selector = '[data-lo-id="hero-signup"]';
const siteId = '018f6b2a-0000-7000-8000-000000000000';
const node = { role: 'cta', selector, tag: 'a', text: 'Começar', textHash: 123 };
const experiment = (target: string) => ({
  siteId, name: 'CTA copy', type: 'cta',
  variants: [
    { name: 'Control', isControl: true },
    { name: 'Variant', changes: [{ selector: target, op: 'set_text', proposedValue: 'Comece hoje' }] },
  ],
});

describe('manual labeling selector contract', () => {
  it('accepts stable IDs and preserves legacy targets in ingestion and experiments', () => {
    for (const target of [selector, '#hero h1', '.cta.primary', 'main > section > h2']) {
      expect(sanitizeSelector(target)).toBe(target);
      expect(CreateExperimentSchema.safeParse(experiment(target)).success).toBe(true);
    }
    expect(sanitizeSelector('section:nth-of-type(2) button.btn')).toBe('section:nth-of-type(2) button.btn');
  });

  it.each([
    '[data-lo-role="cta"]', '[data-lo-id="bad id"]', '[data-lo-id="Uppercase"]',
    '[data-lo-id="customer-123456789"]', '[data-lo-id="hero"] button',
    '[data-lo-id^="hero"]', '[data-lo-id="hero"],input',
    `[data-lo-id="${'a'.repeat(65)}"]`, 'input[value="secret"]', 'a:hover',
  ])('blocks %s in ingestion and experiment creation', (target) => {
    expect(sanitizeSelector(target)).toBe('');
    expect(CreateExperimentSchema.safeParse(experiment(target)).success).toBe(false);
  });

  it('retains manually labeled map nodes and snapshot geometry', () => {
    expect(parsePageMapPayload({ path: '/', counts: { cta: 1 }, nodes: [node] })?.nodes).toEqual([node]);
    const parsed = SnapshotEnvelopeSchema.parse({
      v: 1, siteId, ik: 'test', path: '/', width: 1280, height: 800,
      contentType: 'image/png', image: Buffer.alloc(64).toString('base64'),
      nodes: [{ role: 'cta', selector, rect: [0, 0, 100, 40] }],
    });
    expect(sanitizeSelector(parsed.nodes[0]?.selector)).toBe(selector);
  });

  it('persists the map and retains identities in behavioral ingestion rows', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const insertEvents = vi.fn().mockResolvedValue(undefined);
    const service = new EventsService(
      { pageMap: { upsert }, conversionGoal: { findMany: vi.fn().mockResolvedValue([]) } } as never,
      { allow: vi.fn().mockResolvedValue(true) } as never,
      { insertEvents } as never,
      {
        resolveSite: vi.fn().mockResolvedValue({ active: true, siteId, tenantId: siteId }),
        originAllowed: () => true, hash: () => 'hash', dailySalt: () => 'salt',
        pseudoSession: () => 'opaque-session',
      } as never,
    );
    const envelope = EnvelopeSchema.parse({
      v: 1, siteId, ik: 'test', sid: 'session', ctx: { path: '/' },
      events: [
        { n: 'page_map', t: 0, p: { path: '/', counts: { cta: 1 }, nodes: [node] } },
        ...['cta_click', 'form_start', 'form_submit', 'hover', 'section_view'].map((n) => ({
          n, t: 1, sel: selector, ...(n === 'section_view' ? { sec: 'cta' } : {}),
        })),
      ],
    });
    expect(await service.ingest(envelope, 'https://client.example', undefined)).toBe('ok');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ map: expect.objectContaining({ nodes: [node] }) }),
    }));
    const rows = insertEvents.mock.calls[0]?.[0] as { selector: string; event_name: string; section_id: string }[];
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.selector === selector)).toBe(true);
    expect(rows.find((row) => row.event_name === 'section_view')?.section_id).toBe('cta');
  });
});
