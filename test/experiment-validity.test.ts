import 'reflect-metadata';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExperimentStatus } from '@prisma/client';
import { experimentValidity, EXPERIMENT_VALIDITY_MS } from '../src/modules/experiments/experiment-validity';
import { ExperimentsService } from '../src/modules/experiments/experiments.service';
import { canTransition } from '../src/modules/experiments/experiment-state-machine';

const now = Date.parse('2026-11-21T12:00:00Z');
const user = { userId: 'editor', tenantId: 'tenant', role: 'editor', email: 'editor@example.com' } as const;
afterEach(() => vi.restoreAllMocks());

function setup(status: ExperimentStatus, age = EXPERIMENT_VALIDITY_MS, startedAt: Date | null = null) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const experiment = { id: 'experiment', tenantId: 'tenant', siteId: 'site', status, createdAt: new Date(now - age), updatedAt: new Date(now - age), startedAt };
  const db = {
    experiment: { findUnique: vi.fn().mockResolvedValue(experiment), findMany: vi.fn().mockResolvedValue([experiment]), update: vi.fn(async ({ data }) => ({ ...experiment, ...data })) },
    approval: { create: vi.fn(), updateMany: vi.fn() }, site: { update: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  const publish = vi.fn();
  const service = new ExperimentsService(db as never, { publish } as never, { log: vi.fn() } as never);
  return { experiment, db, publish, service };
}

it('expires unstarted proposals exactly seven elapsed days after creation, independent of approval or schedule time', () => {
  for (const status of ['draft', 'ai_suggested', 'pending_review', 'approved', 'scheduled'] as const) {
    const experiment = { status, createdAt: new Date(now - EXPERIMENT_VALIDITY_MS), startedAt: new Date(now + 1000) };
    expect(experimentValidity(experiment, now - 1).expired).toBe(false);
    expect(experimentValidity(experiment, now)).toEqual({ expired: true, expiresAt: new Date(now) });
  }
  for (const status of ['running', 'paused', 'completed', 'rejected', 'rolled_back'] as const) {
    expect(experimentValidity({ status, createdAt: new Date(0), startedAt: new Date(1000) }, now)).toEqual({ expired: false, expiresAt: null });
  }
});

it('exposes expiry on scoped reads without changing historical records', async () => {
  const { db, service } = setup('approved');
  expect(await service.list('tenant', { siteId: 'site' })).toEqual([expect.objectContaining({ expired: true, expiresAt: new Date(now) })]);
  expect(await service.get('tenant', 'experiment')).toMatchObject({ status: 'approved', expired: true });
  expect(db.experiment.update).not.toHaveBeenCalled();
  await expect(service.get('foreign', 'experiment')).rejects.toMatchObject({ status: 403 });
});

it('blocks edits, submissions, approvals, scheduling and starting of expired proposals before any write or publication', async () => {
  for (const [status, action] of [['draft', 'update'], ['draft', 'submit'], ['pending_review', 'approve'], ['approved', 'schedule'], ['approved', 'start']] as const) {
    const { service, db, publish } = setup(status);
    const operation = action === 'update' ? service.update(user, 'experiment', { name: 'Novo nome' })
      : action === 'approve' ? service.approve(user, 'experiment', {})
      : action === 'schedule' ? service.schedule(user, 'experiment', { startAt: new Date(now + 1000).toISOString() })
      : service[action](user, 'experiment');
    await expect(operation).rejects.toMatchObject({ status: 409 });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  }
});

it('checks expiry again inside the write and guards the atomic update against crossing the deadline', async () => {
  const { service, db } = setup('approved', EXPERIMENT_VALIDITY_MS - 1);
  await service.start(user, 'experiment');
  expect(db.experiment.update).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant', status: 'approved', createdAt: { gt: new Date(now - EXPERIMENT_VALIDITY_MS) } }) }));
  const second = setup('approved', EXPERIMENT_VALIDITY_MS - 1);
  second.db.$transaction.mockImplementation(async fn => { vi.mocked(Date.now).mockReturnValue(now + 1); return fn(second.db); });
  await expect(second.service.start(user, 'experiment')).rejects.toMatchObject({ status: 409 });
  expect(second.db.experiment.update).not.toHaveBeenCalled();
});

it('preserves running and genuinely paused tests, but pausing a schedule cannot bypass expiration', async () => {
  const running = setup('running', EXPERIMENT_VALIDITY_MS * 2, new Date(now - 1000));
  await expect(running.service.pause(user, 'experiment')).resolves.toMatchObject({ status: 'paused' });
  const paused = setup('paused', EXPERIMENT_VALIDITY_MS * 2, new Date(now - 1000));
  await expect(paused.service.start(user, 'experiment')).resolves.toMatchObject({ status: 'running', startedAt: paused.experiment.startedAt });
  const scheduled = setup('scheduled', 1000, new Date(now + 1000));
  await expect(scheduled.service.pause(user, 'experiment')).resolves.toMatchObject({ status: 'paused', startedAt: null });
  const neverStarted = setup('paused', EXPERIMENT_VALIDITY_MS, null);
  await expect(neverStarted.service.start(user, 'experiment')).rejects.toMatchObject({ status: 409 });
});

it('allows refusing an approved proposal without demanding another approval', async () => {
  const { service } = setup('approved', 1000);
  await expect(service.reject(user, 'experiment', { reason: 'Não usar esta proposta' })).resolves.toMatchObject({ status: 'rejected' });
  expect(canTransition('draft', 'rejected')).toBe(true);
  expect(canTransition('scheduled', 'rejected')).toBe(true);
  expect(canTransition('running', 'rejected')).toBe(false);
});
