import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { JwtAuthGuard } from '../src/common/auth/jwt-auth.guard';
import { RolesGuard } from '../src/common/auth/roles.guard';
import { TeamController } from '../src/modules/team/team.controller';
import { ExperimentsController } from '../src/modules/experiments/experiments.controller';
import { AuthController } from '../src/modules/auth/auth.controller';
import type { AuthUser } from '../src/common/auth/auth.types';

function context(role: AuthUser['role'], method: string, path: string, handler: Function = () => {}) {
  const request = { method, url: path, headers: { authorization: 'Bearer access-token' }, user: { userId: 'u', tenantId: 't', role, email: 'a@example.com' } };
  const ctx = {
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { request, ctx };
}

describe('role authorization', () => {
  const guard = new RolesGuard(new Reflector());

  it.each(['admin', 'editor', 'viewer'] as const)('enforces the %s access matrix', (role) => {
    const { ctx: teamRead } = context(role, 'GET', '/v1/team', TeamController.prototype.list);
    const { ctx: invite } = context(role, 'POST', '/v1/team/invitations', TeamController.prototype.invite);
    const { ctx: changeRole } = context(role, 'PATCH', '/v1/team/members/id/role', TeamController.prototype.changeRole);
    const { ctx: revoke } = context(role, 'DELETE', '/v1/team/invitations/id', TeamController.prototype.revoke);
    const { ctx: remove } = context(role, 'DELETE', '/v1/team/members/id', TeamController.prototype.removeMember);
    const { ctx: reactivate } = context(role, 'POST', '/v1/team/reactivations', TeamController.prototype.reactivate);
    if (role === 'viewer') expect(() => guard.canActivate(teamRead)).toThrow();
    else expect(guard.canActivate(teamRead)).toBe(true);
    for (const ctx of [invite, changeRole, revoke, remove, reactivate]) {
      if (role === 'admin') expect(guard.canActivate(ctx)).toBe(true);
      else expect(() => guard.canActivate(ctx)).toThrow();
    }
  });

  it('allows editors to approve and reject experiments', () => {
    for (const handler of [ExperimentsController.prototype.approve, ExperimentsController.prototype.reject]) {
      expect(guard.canActivate(context('editor', 'POST', '/v1/experiments/id/approve', handler).ctx)).toBe(true);
      expect(() => guard.canActivate(context('viewer', 'POST', '/v1/experiments/id/approve', handler).ctx)).toThrow();
    }
  });

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('denies viewers even if a new %s route forgets a role annotation', (method) => {
    expect(() => guard.canActivate(context('viewer', method, '/v1/new-feature').ctx)).toThrow();
    expect(guard.canActivate(context('editor', method, '/v1/new-feature').ctx)).toBe(true);
  });

  it('allows normal reads, logout and public invitation acceptance', () => {
    expect(guard.canActivate(context('viewer', 'GET', '/v1/analytics/overview').ctx)).toBe(true);
    expect(guard.canActivate(context('viewer', 'POST', '/v1/auth/logout').ctx)).toBe(true);
    expect(guard.canActivate(context('viewer', 'POST', '/v1/auth/register', AuthController.prototype.register).ctx)).toBe(true);
  });
});

describe('current membership authorization', () => {
  function setup() {
    const jwt = { verifyAsync: vi.fn().mockResolvedValue({ sub: 'u', tid: 't', role: 'admin', email: 'old@example.com' }) };
    const prisma = { userMembership: { findUnique: vi.fn().mockResolvedValue({ role: 'viewer', user: { email: 'current@example.com', sessionVersion: 0 }, tenant: { archivedAt: null } }) } };
    const guard = new JwtAuthGuard(jwt as unknown as JwtService, new Reflector(), prisma as unknown as PrismaService);
    return { jwt, prisma, guard, ...context('admin', 'GET', '/v1/team') };
  }

  it('replaces stale token roles and email with the current tenant membership', async () => {
    const { guard, ctx, request, prisma } = setup();
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(request.user).toMatchObject({ role: 'viewer', email: 'current@example.com' });
    expect(prisma.userMembership.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId_userId: { tenantId: 't', userId: 'u' } } }));
  });

  it('rejects a refresh token at protected routes', async () => {
    const { guard, ctx, jwt, prisma } = setup();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u', tid: 't', typ: 'refresh' });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 401 });
    expect(prisma.userMembership.findUnique).not.toHaveBeenCalled();
  });

  it('rejects removed tenant memberships and preserves infrastructure failures', async () => {
    const { guard, ctx, prisma } = setup();
    prisma.userMembership.findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 401 });
    prisma.userMembership.findUnique.mockRejectedValue(new Error('database unavailable'));
    await expect(guard.canActivate(ctx)).rejects.toThrow('database unavailable');
  });

  it('rejects access tokens after password reset or tenant archival', async () => {
    const { guard, ctx, prisma } = setup();
    prisma.userMembership.findUnique.mockResolvedValue({ role: 'viewer', user: { email: 'current@example.com', sessionVersion: 1 }, tenant: { archivedAt: null } });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 401 });
    prisma.userMembership.findUnique.mockResolvedValue({ role: 'viewer', user: { email: 'current@example.com', sessionVersion: 0 }, tenant: { archivedAt: new Date() } });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 401 });
  });
});
