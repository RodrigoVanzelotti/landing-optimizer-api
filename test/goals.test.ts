import { describe, expect, it, vi } from 'vitest';
import { CreateGoalSchema, parseGoalMatcher } from '../src/modules/goals/goals.dto';
import { ExperimentsService } from '../src/modules/experiments/experiments.service';
import { UpdateExperimentSchema } from '../src/modules/experiments/experiments.dto';

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

  it('accepts labeled forms and rejects unsafe or unreachable selectors', () => {
    const selector = '[data-lo-id="lead-form"]';
    expect(parseGoalMatcher('form_submit', { selector: ` ${selector} ` })).toEqual({ selector });
    expect(() => parseGoalMatcher('form_submit', { selector: 'input[value="private"]' })).toThrow();
    expect(() => CreateGoalSchema.parse({ name: 'a'.repeat(65) })).toThrow();
  });
});

it('sets the primary goal on a draft with site ownership checks and freezes it after review', async () => {
  const findUnique = vi.fn().mockResolvedValue({ tenantId: 'tenant', siteId: 'site', status: 'draft' });
  const findFirst = vi.fn().mockResolvedValue({ id: 'goal' });
  const update = vi.fn().mockResolvedValue({});
  const tx = { experiment: { findUnique, update }, conversionGoal: { findFirst } };
  const service = new ExperimentsService({ ...tx, $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as never, {} as never, { log: vi.fn().mockResolvedValue(undefined) } as never);
  const user = { userId: 'editor', tenantId: 'tenant', email: 'editor@example.com', role: 'editor' as const };
  await service.update(user, 'experiment', UpdateExperimentSchema.parse({ primaryGoalId: 'goal' }));
  expect(findFirst).toHaveBeenCalledWith({ where: { id: 'goal', siteId: 'site' }, select: { id: true } });
  expect(update).toHaveBeenCalledWith({ where: { id: 'experiment' }, data: { primaryGoal: { connect: { id: 'goal' } } } });
  await service.update(user, 'experiment', { primaryGoalId: null });
  expect(update).toHaveBeenLastCalledWith({ where: { id: 'experiment' }, data: { primaryGoal: { disconnect: true } } });
  findFirst.mockResolvedValue(null);
  await expect(service.update(user, 'experiment', { primaryGoalId: 'foreign-goal' })).rejects.toThrow('Unknown conversion goal for this site');
  findUnique.mockResolvedValue({ tenantId: 'tenant', siteId: 'site', status: 'running' });
  await expect(service.update(user, 'experiment', { primaryGoalId: 'goal' })).rejects.toThrow('Cannot edit experiment');
  expect(update).toHaveBeenCalledTimes(2);
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
