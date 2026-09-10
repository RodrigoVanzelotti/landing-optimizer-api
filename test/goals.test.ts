import { describe, expect, it } from 'vitest';
import { CreateGoalSchema, parseGoalMatcher } from '../src/modules/goals/goals.dto';

describe('goal matcher validation', () => {
  it('event matcher accepts empty input and rejects extra keys', () => {
    expect(parseGoalMatcher('event', {})).toEqual({});
    expect(parseGoalMatcher('event', undefined)).toEqual({});
    expect(() => parseGoalMatcher('event', { foo: 1 })).toThrow();
  });

  it('url matcher requires a path and defaults op to exact', () => {
    expect(parseGoalMatcher('url', { path: '/pricing' })).toEqual({ op: 'exact', path: '/pricing' });
    expect(parseGoalMatcher('url', { op: 'prefix', path: '/app' })).toEqual({
      op: 'prefix',
      path: '/app',
    });
    expect(() => parseGoalMatcher('url', {})).toThrow();
  });

  it('url regex matcher rejects an invalid pattern but accepts a valid one', () => {
    expect(() => parseGoalMatcher('url', { op: 'regex', path: '(' })).toThrow();
    expect(parseGoalMatcher('url', { op: 'regex', path: '^/blog/.*$' })).toEqual({
      op: 'regex',
      path: '^/blog/.*$',
    });
  });

  it('form_submit matcher allows an optional selector', () => {
    expect(parseGoalMatcher('form_submit', {})).toEqual({});
    expect(parseGoalMatcher('form_submit', { selector: '#signup' })).toEqual({
      selector: '#signup',
    });
  });
});

describe('CreateGoalSchema', () => {
  it('defaults kind to event and normalizes the matcher', () => {
    expect(CreateGoalSchema.parse({ name: 'Signup' })).toEqual({
      name: 'Signup',
      kind: 'event',
      matcher: {},
    });
  });

  it('trims the name and rejects invalid characters', () => {
    expect(CreateGoalSchema.parse({ name: '  Free trial  ' }).name).toBe('Free trial');
    expect(() => CreateGoalSchema.parse({ name: '<script>' })).toThrow();
  });

  it('reports matcher errors under the matcher path for url goals', () => {
    const res = CreateGoalSchema.safeParse({ name: 'Visit pricing', kind: 'url', matcher: {} });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path[0] === 'matcher')).toBe(true);
    }
  });
});
