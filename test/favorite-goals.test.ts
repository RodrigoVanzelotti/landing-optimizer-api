import 'reflect-metadata';
import { expect, it, vi } from 'vitest';
import { GoalsService } from '../src/modules/goals/goals.service';
import { CreateGoalSchema, UpdateGoalSchema } from '../src/modules/goals/goals.dto';

const user = { userId: 'editor', tenantId: 'tenant', role: 'editor', email: 'editor@example.com' } as const;
function setup() {
  const goals = [{ id: 'old', siteId: 'site', name: 'Existing', isFavorite: true, kind: 'event' }];
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'site' }]),
    conversionGoal: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn(async ({ where }) => goals.find(goal => goal.id === where.id && goal.siteId === where.siteId) ?? null),
      updateMany: vi.fn(async () => { goals.forEach(goal => { goal.isFavorite = false; }); return { count: 1 }; }),
      create: vi.fn(async ({ data }) => { goals.push(data); return data; }),
      update: vi.fn(async ({ where, data }) => { const goal = goals.find(item => item.id === where.id)!; Object.assign(goal, data); return goal; }),
    },
  };
  const db = { ...tx, site: { findUnique: vi.fn().mockResolvedValue({ tenantId: 'tenant' }) }, $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
    const previous = structuredClone(goals);
    try { return await fn(tx); } catch (error) { goals.splice(0, goals.length, ...previous); throw error; }
  } };
  const audit = { log: vi.fn() };
  return { goals, tx, audit, service: new GoalsService(db as never, audit as never) };
}

it('creates a site-wide favorite atomically and serializes replacements using the authorized site', async () => {
  const { service, goals, tx } = setup();
  await service.create(user, 'site', CreateGoalSchema.parse({ name: 'Lead', isFavorite: true }));
  expect(goals.filter(goal => goal.isFavorite).map(goal => goal.name)).toEqual(['Lead']);
  expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['site', 'tenant']);
  expect(tx.conversionGoal.updateMany).toHaveBeenCalledWith({ where: { siteId: 'site', isFavorite: true }, data: { isFavorite: false } });
  await service.update(user, 'site', 'old', { isFavorite: true });
  expect(goals.filter(goal => goal.isFavorite).map(goal => goal.id)).toEqual(['old']);
});

it('preserves the favorite after a failed audit and rejects cross-tenant or cross-site changes', async () => {
  const { service, goals, audit, tx } = setup();
  audit.log.mockRejectedValue(new Error('Audit unavailable'));
  await expect(service.create(user, 'site', CreateGoalSchema.parse({ name: 'Lead', isFavorite: true }))).rejects.toThrow('Audit unavailable');
  expect(goals.map(goal => [goal.id, goal.isFavorite])).toEqual([['old', true]]);
  tx.$queryRaw.mockClear();
  await expect(service.update({ ...user, tenantId: 'other' }, 'site', 'old', { isFavorite: true })).rejects.toMatchObject({ status: 403 });
  await expect(service.update(user, 'other-site', 'old', { isFavorite: true })).rejects.toMatchObject({ status: 404 });
  expect(tx.$queryRaw).not.toHaveBeenCalled();
});

it('validates favorite inputs and does not change an existing favorite on ordinary creation', async () => {
  expect(CreateGoalSchema.safeParse({ name: 'Lead', isFavorite: 'true' }).success).toBe(false);
  expect(UpdateGoalSchema.safeParse({ isFavorite: 1 }).success).toBe(false);
  const { service, goals, tx } = setup();
  await service.create(user, 'site', CreateGoalSchema.parse({ name: 'Lead' }));
  expect(goals.filter(goal => goal.isFavorite).map(goal => goal.id)).toEqual(['old']);
  expect(tx.$queryRaw).not.toHaveBeenCalled();
});
