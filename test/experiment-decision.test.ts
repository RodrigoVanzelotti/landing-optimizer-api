import 'reflect-metadata';
import { expect, it, vi } from 'vitest';
import { ExperimentsService } from '../src/modules/experiments/experiments.service';
import { ExperimentEvaluator } from '../src/modules/experiments/experiment-evaluator.service';
import { SiteConfigService } from '../src/modules/sites/site-config.service';

const user = { userId: 'editor', tenantId: 'tenant', role: 'editor', email: 'editor@example.com' } as const;
function setup(conclusive = true) {
  const snapshot = { version: 1, conclusive, coverageComplete: true, recordedAt: '2026-11-20', experimentId: 'experiment', experiment: { siteId: 'site' }, variants: [{ variantId: 'control', isControl: true, exposures: 10000, conversions: 1000 }, { variantId: 'proposal', isControl: false, exposures: 10000, conversions: 1200 }], series: [{ date: '2026-11-20', variants: [] }] };
  const experiment = { id: 'experiment', tenantId: 'tenant', siteId: 'site', status: 'completed', createdAt: new Date(0), updatedAt: new Date(), endedAt: new Date('2026-11-20'), resultSnapshot: snapshot };
  const db = { experiment: { findUnique: vi.fn().mockResolvedValue(experiment), update: vi.fn(async ({ data }) => ({ ...experiment, ...data })) }, variant: { findFirst: vi.fn().mockResolvedValue({ id: 'proposal' }) }, site: { update: vi.fn() }, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db) };
  const publish = vi.fn(), log = vi.fn();
  const service = new ExperimentsService(db as never, { publish } as never, { log } as never, {} as never);
  return { experiment, db, publish, service, log };
}
it('accepts only a proposed variant from a conclusive snapshot, audits and invalidates config before publication', async () => {
  const { service, db, publish, log } = setup();
  expect(await service.accept(user, 'experiment', 'proposal')).toMatchObject({ status: 'accepted', winnerVariantId: 'proposal' });
  expect(db.site.update).toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: 'experiment.accepted' }), db);
  expect(publish).toHaveBeenCalledWith('site', 'editor');
});
it('rejects foreign tenants, foreign/control proposals, inconclusive snapshots and every manual completion', async () => {
  const { service, db } = setup();
  await expect(service.accept({ ...user, tenantId: 'foreign' }, 'experiment', 'proposal')).rejects.toMatchObject({ status: 403 });
  await expect(service.accept(user, 'experiment', 'control')).rejects.toMatchObject({ status: 409 });
  await expect(setup(false).service.accept(user, 'experiment', 'proposal')).rejects.toMatchObject({ status: 409 });
  await expect(service.complete(user, 'experiment', {})).rejects.toMatchObject({ status: 409 });
  expect(db.experiment.update).not.toHaveBeenCalled();
});
it('publishes an accepted change to every eligible visitor with one chosen variant and keeps the normal split for ongoing tests', async () => {
  const db = { site: { findUnique: vi.fn().mockResolvedValue({ id: 'site', status: 'active', configVersion: 2, samplingRate: 1, tenant: { archivedAt: null } }) }, experiment: { findMany: vi.fn().mockResolvedValue([
    { id: 'accepted', status: 'accepted', winnerVariantId: 'proposal', allocation: .5, variants: [{ id: 'control', weight: .5, isControl: true, changes: [] }, { id: 'proposal', weight: .5, isControl: false, changes: [] }] },
    { id: 'running', status: 'running', allocation: .5, variants: [{ id: 'control', weight: .5, isControl: true, changes: [] }, { id: 'other', weight: .5, isControl: false, changes: [] }] },
  ]) } };
  const lockedDb = { ...db, conversionGoal: { findMany: vi.fn().mockResolvedValue([]) }, $queryRaw: vi.fn().mockResolvedValue([{ id: 'site' }]) };
  const config = new SiteConfigService({ ...lockedDb, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(lockedDb) } as never, { get: vi.fn(), set: vi.fn() } as never, { signConfig: () => 'signature' } as never);
  const result = await config.get('site');
  expect(result?.experiments[0]).toMatchObject({ allocation: 1, permanent: true, variants: [{ id: 'proposal', weight: 1, isControl: false }] });
  expect(result?.experiments[0]?.variants).toHaveLength(1);
  expect(result?.experiments[1]?.allocation).toBe(.5);
  expect(result?.experiments[1]?.permanent).toBeUndefined();
  expect(result?.experiments[1]?.variants).toHaveLength(2);
});
it.each([[true, 'running', true], [false, 'running', false], [false, 'completed', true]] as const)('automatically evaluates conclusive=%s status=%s without inventing results', async (conclusive, status, changes) => {
  const experiment = { id: 'experiment', siteId: 'site', tenantId: 'tenant', status, updatedAt: new Date(), evaluationPlan: { version: 1 }, endedAt: null };
  const db = { experiment: { findMany: vi.fn().mockResolvedValue([experiment]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, site: { update: vi.fn() }, auditLog: { create: vi.fn() }, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db) };
  const report = { conclusive, coverageComplete: true, experimentId: 'experiment', experiment: { siteId: 'site' }, version: 1, recordedAt: '2026-11-23T00:00:00Z', variants: [{ isControl: true, exposures: 10000, conversions: 1000 }, { isControl: false, exposures: 10000, conversions: 1200 }], series: [{ date: '2026-11-23', variants: [] }] };
  const publish = vi.fn();
  await new ExperimentEvaluator(db as never, { report: vi.fn().mockResolvedValue(report) } as never, { publish } as never).reconcile();
  expect(db.experiment.updateMany).toHaveBeenCalledTimes(changes ? 1 : 0);
  if (changes) {
    expect(db.experiment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ updatedAt: experiment.updatedAt, status }), data: expect.objectContaining({ status: conclusive ? 'completed' : 'paused' }) }));
    expect(db.auditLog.create).toHaveBeenCalled(); expect(publish).toHaveBeenCalled();
  }
});
