import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/modules/auth/auth.service';
import { PreferencesSchema } from '../src/modules/auth/auth.dto';
import { ApprovalsService } from '../src/modules/approvals/approvals.module';
import type { AuthUser } from '../src/common/auth/auth.types';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../src/config/env';
import type { TeamService } from '../src/modules/team/team.service';

const user: AuthUser = { userId: 'user-a', tenantId: 'tenant-a', email: 'a@example.com', role: 'viewer' };
const site = '00000000-0000-4000-a000-000000000001';
function setup(rows: { favoriteSiteId: string | null }[]) {
  const tx = { $queryRaw: vi.fn().mockResolvedValue(rows), auditLog: { create: vi.fn() } };
  const db = { ...tx, $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)) };
  const service = new AuthService(db as unknown as PrismaService, {} as JwtService, {} as ConfigService<AppEnv, true>, {} as TeamService);
  return { service, tx };
}
describe('personal favorite site', () => {
  it('validates a single nullable site ID without accepting another user or tenant', () => {
    expect(PreferencesSchema.parse({ favoriteSiteId: site })).toEqual({ favoriteSiteId: site });
    expect(PreferencesSchema.parse({ favoriteSiteId: null })).toEqual({ favoriteSiteId: null });
    for (const value of [{}, { favoriteSiteId: 'invalid' }, { favoriteSiteId: site, userId: 'other' }, { favoriteSiteId: [site] }]) expect(PreferencesSchema.safeParse(value).success).toBe(false);
  });
  it('scopes reads to the authenticated user and workspace', async () => {
    const { service, tx } = setup([{ favoriteSiteId: site }]);
    expect(await service.preferences(user)).toEqual({ favoriteSiteId: site });
    expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual([user.userId, user.tenantId]);
  });
  it.each([site, null])('atomically replaces or removes the viewer’s personal favorite: %s', async favoriteSiteId => {
    const { service, tx } = setup([{ favoriteSiteId }]);
    expect(await service.updatePreferences(user, favoriteSiteId)).toEqual({ favoriteSiteId });
    expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual([favoriteSiteId, user.userId, user.tenantId, favoriteSiteId, favoriteSiteId, user.tenantId]);
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actorUserId: user.userId, tenantId: user.tenantId, metadata: { favoriteSiteId } }) }));
  });
  it('rejects a missing or foreign-workspace site without recording a successful change', async () => {
    const { service, tx } = setup([]);
    await expect(service.updatePreferences(user, site)).rejects.toMatchObject({ status: 404 });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('filters approval queues by both tenant and selected site', async () => {
    const db = { approval: { findMany: vi.fn().mockResolvedValue([]) } };
    await new ApprovalsService(db as unknown as PrismaService).listQueue(user.tenantId, 'pending', site);
    expect(db.approval.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'pending', experiment: { tenantId: user.tenantId, siteId: site } } }));
  });
});
