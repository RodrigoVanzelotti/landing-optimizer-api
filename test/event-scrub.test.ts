import { describe, expect, it } from 'vitest';
import {
  EVENT_NAMES,
  looksLikePii,
  parsePageMapPayload,
  sanitizePath,
  sanitizeSelector,
  scrubProps,
} from '../src/modules/events/event-scrub';

describe('event names', () => {
  it('accepts the hover attention event', () => {
    expect(EVENT_NAMES).toContain('hover');
  });
});

describe('sanitizeSelector', () => {
  it('accepts id/class/tag chains with combinators', () => {
    expect(sanitizeSelector('#cta-primary')).toBe('#cta-primary');
    expect(sanitizeSelector('div.hero > h1')).toBe('div.hero > h1');
    expect(sanitizeSelector('section:nth-of-type(2) button.btn')).toBe(
      'section:nth-of-type(2) button.btn',
    );
  });

  it('drops attribute selectors and pseudo-classes (value exfiltration vectors)', () => {
    expect(sanitizeSelector('input[value="secret"]')).toBe('');
    expect(sanitizeSelector('a:hover')).toBe('');
    expect(sanitizeSelector('*{}</script>')).toBe('');
  });

  it('drops PII-shaped and empty input', () => {
    expect(sanitizeSelector('#user-jane@example.com')).toBe('');
    expect(sanitizeSelector(undefined)).toBe('');
    expect(sanitizeSelector('   ')).toBe('');
  });
});

describe('parsePageMapPayload', () => {
  const validNode = { role: 'hero', selector: '#hero', tag: 'section', text: 'Ship faster' };

  it('accepts the SDK page-map shape and sanitizes the path', () => {
    const parsed = parsePageMapPayload({
      path: '/pricing?utm=x',
      counts: { hero: 1 },
      nodes: [validNode],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.path).toBe('/pricing');
    expect(parsed?.nodes).toHaveLength(1);
  });

  it('drops nodes with unsafe selectors instead of rejecting the payload', () => {
    const parsed = parsePageMapPayload({
      path: '/',
      nodes: [validNode, { role: 'cta', selector: 'a[href="x"]', tag: 'a' }],
    });
    expect(parsed?.nodes).toHaveLength(1);
    expect(parsed?.nodes[0]?.selector).toBe('#hero');
  });

  it('drops PII-shaped node text but keeps the node', () => {
    const parsed = parsePageMapPayload({
      path: '/',
      nodes: [{ role: 'form', selector: '#signup', tag: 'form', text: 'mail me: a@b.com' }],
    });
    expect(parsed?.nodes[0]?.selector).toBe('#signup');
    expect(parsed?.nodes[0]?.text).toBeUndefined();
  });

  it('rejects payloads that are not page maps at all', () => {
    expect(parsePageMapPayload(undefined)).toBeNull();
    expect(parsePageMapPayload({ nodes: 'nope' })).toBeNull();
    expect(parsePageMapPayload({ path: '/', nodes: [] })).toBeNull();
  });
});

describe('scrubProps + sanitizePath (regression coverage)', () => {
  it('drops PII-shaped strings and nested objects, caps keys', () => {
    const out = JSON.parse(
      scrubProps({
        ok: 'value',
        email: 'jane@example.com',
        nested: { deep: true },
        n: 42,
      }) || '{}',
    ) as Record<string, unknown>;
    expect(out).toEqual({ ok: 'value', n: 42 });
  });

  it('detects common PII shapes', () => {
    expect(looksLikePii('a@b.co')).toBe(true);
    expect(looksLikePii('411111111111')).toBe(true);
    expect(looksLikePii('plain text')).toBe(false);
  });

  it('strips query and hash from paths', () => {
    expect(sanitizePath('/x?q=1#top')).toBe('/x');
    expect(sanitizePath('')).toBe('/');
  });
});
