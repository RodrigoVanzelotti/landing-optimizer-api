import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { AppEnv } from '../src/config/env';
import type { AuthUser } from '../src/common/auth/auth.types';
import { TeamService } from '../src/modules/team/team.service';
import { InviteUserSchema, ReactivateUserSchema } from '../src/modules/team/team.dto';
import { hashInvitationToken, newInvitation } from '../src/modules/team/invitation';

vi.mock('argon2', () => ({ argon2id: 2, hash: vi.fn().mockResolvedValue('password-hash') }));
const admin: AuthUser = { tenantId: 'tenant-a', userId: 'admin', email: 'admin@example.com', role: 'admin' };
const input = { name: 'Ana', email: 'ana@example.com', role: 'viewer' as const };

function setup(options: { users?: number; admins?: number; pending?: number; adminPending?: number; actorRole?: string; targetRole?: string } = {}) {
  const invitation = { ...newInvitation(admin.tenantId, input, 'https://dashboard.example.com', admin.userId).data, acceptedAt: null as Date | null, revokedAt: null as Date | null };
  const tx = {
    auditLog: { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: admin.tenantId }]),
    user: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    userMembership: {
      findUnique: vi.fn().mockResolvedValue({ role: options.actorRole ?? 'admin', user: { email: admin.email } }),
      findFirst: vi.fn().mockResolvedValue({ id: 'member', userId: 'member-user', tenantId: admin.tenantId, role: options.targetRole ?? 'editor' }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn(async ({ where }: { where: { role?: unknown } }) => where.role ? options.admins ?? 1 : options.users ?? 1),
      create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue({}),
    },
    teamInvitation: {
      findUnique: vi.fn().mockResolvedValue(invitation),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(async ({ where }: { where: { id?: string; email: string; expiresAt: { gt: Date } } }) => {
        if (!where.id) return null;
        return where.id === invitation.id && where.email === invitation.email && !invitation.acceptedAt && !invitation.revokedAt && invitation.expiresAt > where.expiresAt.gt ? invitation : null;
      }),
      count: vi.fn(async ({ where }: { where: { role?: unknown } }) => where.role ? options.adminPending ?? 0 : options.pending ?? 0),
      create: vi.fn().mockResolvedValue({ id: 'invite' }),
      update: vi.fn(async ({ data }: { data: { acceptedAt: Date } }) => { invitation.acceptedAt = data.acceptedAt; return invitation; }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) };
  const config = { get: () => 'https://dashboard.example.com' };
  const service = new TeamService(prisma as unknown as PrismaService, config as unknown as ConfigService<AppEnv, true>);
  return { service, tx, prisma, invitation };
}

describe('tenant team invitations', () => {
  it('permanently revokes account sessions when a member is removed, without resetting the version on reactivation', async () => {
    const { service, tx, invitation } = setup();
    await service.removeMember(admin, 'member');
    expect(tx.user.updateMany).toHaveBeenCalledWith({ where: { id: 'member-user' }, data: { sessionVersion: { increment: 1 } } });
    tx.user.findFirst.mockResolvedValue({ id: 'member-user', memberships: [] });
    tx.teamInvitation.findFirst.mockResolvedValue({ ...invitation, acceptedAt: new Date() });
    await service.reactivate(admin, input);
    expect(tx.user.updateMany).toHaveBeenCalledOnce();
  });
  it('prevents a tenant administrator from provisioning the platform identity, including an old invitation', async () => {
    const { service, tx, invitation } = setup();
    const email = 'rodrigovanzelotti@gmail.com';
    await expect(service.invite({ ...admin, email: 'attacker@gmail.com' }, { ...input, email })).rejects.toMatchObject({ status: 403 });
    expect(tx.teamInvitation.create).not.toHaveBeenCalled();
    invitation.email = email;
    await expect(service.accept('token', email, 'Platform owner', 'password')).rejects.toMatchObject({ status: 403 });
    expect(tx.user.create).not.toHaveBeenCalled();
  });
  it('stores only a token hash and produces encoded personalized links with a secret fragment', async () => {
    const { service, tx } = setup();
    const result = await service.invite(admin, input);
    const url = new URL(result.url);
    const token = url.hash.slice(1);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get('name')).toBe('Ana');
    expect(url.searchParams.get('email')).toBe(input.email);
    expect(url.search).not.toContain(token);
    expect(tx.teamInvitation.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: admin.tenantId, tokenHash: hashInvitationToken(token), invitedByUserId: admin.userId }) }));
    expect(JSON.stringify(tx.teamInvitation.create.mock.calls)).not.toContain(token);
  });

  it.each(['ana@other.com', 'ana@sub.example.com', 'ana@example.com.evil'])('rejects a different exact email domain: %s', async (email) => {
    const { service, tx } = setup();
    await expect(service.invite(admin, { ...input, email })).rejects.toMatchObject({ status: 403 });
    expect(tx.teamInvitation.create).not.toHaveBeenCalled();
  });

  it.each(['editor', 'viewer'])('rechecks current administrator membership for %s', async (actorRole) => {
    const { service, tx } = setup({ actorRole });
    await expect(service.invite(admin, input)).rejects.toMatchObject({ status: 403 });
    await expect(service.changeRole(admin, 'member', 'admin')).rejects.toMatchObject({ status: 403 });
    await expect(service.revoke(admin, 'invite')).rejects.toMatchObject({ status: 403 });
    await expect(service.removeMember(admin, 'member')).rejects.toMatchObject({ status: 403 });
    await expect(service.reactivate(admin, input)).rejects.toMatchObject({ status: 403 });
    expect(tx.teamInvitation.create).not.toHaveBeenCalled();
    expect(tx.userMembership.delete).not.toHaveBeenCalled();
  });

  it.each([{ users: 10 }, { users: 8, pending: 2 }])('reserves user slots and refuses an eleventh user (%j)', async (options) => {
    const { service, tx } = setup(options);
    await expect(service.invite(admin, input)).rejects.toMatchObject({ status: 409 });
    expect(tx.teamInvitation.create).not.toHaveBeenCalled();
  });

  it.each([{ admins: 3 }, { admins: 2, adminPending: 1 }])('reserves admin slots for invitations and promotions (%j)', async (options) => {
    const { service, tx } = setup(options);
    await expect(service.invite(admin, { ...input, role: 'admin' })).rejects.toMatchObject({ status: 409 });
    await expect(service.changeRole(admin, 'member', 'admin')).rejects.toMatchObject({ status: 409 });
    expect(tx.userMembership.update).not.toHaveBeenCalled();
  });

  it('allows the tenth reserved user and third reserved administrator', async () => {
    const { service } = setup({ users: 8, pending: 1, admins: 1, adminPending: 1 });
    await expect(service.invite(admin, { ...input, role: 'admin' })).resolves.toHaveProperty('url');
  });

  it('rejects existing accounts and duplicate pending invites', async () => {
    const { service, tx } = setup();
    tx.user.findFirst.mockResolvedValue({ id: 'existing', memberships: [] });
    await expect(service.invite(admin, input)).rejects.toMatchObject({ status: 409 });
    tx.user.findFirst.mockResolvedValue(null);
    tx.teamInvitation.findFirst.mockResolvedValue({ id: 'duplicate' } as never);
    await expect(service.invite(admin, input)).rejects.toMatchObject({ status: 409 });
  });

  it('never demotes the last administrator, but allows demotion when another remains', async () => {
    const { service, tx } = setup({ targetRole: 'admin' });
    await expect(service.changeRole(admin, 'member', 'viewer')).rejects.toMatchObject({ status: 409 });
    expect(tx.userMembership.update).not.toHaveBeenCalled();
    tx.userMembership.count.mockResolvedValue(2);
    await service.changeRole(admin, 'member', 'editor');
    expect(tx.userMembership.update).toHaveBeenCalledWith(expect.objectContaining({ data: { role: 'editor' } }));
  });

  it('does not expose or modify records belonging to another tenant', async () => {
    const { service, tx } = setup();
    await service.list(admin);
    expect(tx.userMembership.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: admin.tenantId } }));
    tx.userMembership.findFirst.mockResolvedValue(null);
    await expect(service.changeRole(admin, 'foreign-member', 'admin')).rejects.toMatchObject({ status: 404 });
    expect(tx.userMembership.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign-member', tenantId: admin.tenantId } });
    tx.teamInvitation.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.revoke(admin, 'foreign-invite')).rejects.toMatchObject({ status: 404 });
    expect(tx.teamInvitation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'foreign-invite', tenantId: admin.tenantId }) }));
  });

  it('waits for the tenant row lock before checking capacity', async () => {
    const { service, tx } = setup();
    let release!: (rows: { id: string }[]) => void;
    tx.$queryRaw.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const pending = service.invite(admin, input);
    await Promise.resolve();
    expect(tx.userMembership.count).not.toHaveBeenCalled();
    expect(tx.teamInvitation.create).not.toHaveBeenCalled();
    release([{ id: admin.tenantId }]);
    await pending;
    expect(tx.$queryRaw.mock.calls[0]?.[0].join('')).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.calls[0]?.[1]).toBe(admin.tenantId);
  });
});

describe('reactivating former team members', () => {
  function former(options: Parameters<typeof setup>[0] = {}) {
    const context = setup(options);
    context.tx.user.findFirst.mockResolvedValue({ id: 'existing', memberships: [] });
    context.tx.teamInvitation.findFirst.mockResolvedValue({ id: 'accepted-invite' } as never);
    return context;
  }

  it('offers reactivation without creating an invitation or restoring access before confirmation', async () => {
    const { service, tx } = former();
    const error = await service.invite(admin, input).catch(error => error);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ errors: { reactivationAvailable: true } });
    expect(tx.userMembership.create).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.teamInvitation.create).not.toHaveBeenCalled();
  });

  it('restores only this workspace membership, with the chosen role and the existing account ID', async () => {
    const { service, tx } = former();
    await service.reactivate(admin, { email: input.email, role: 'editor' });
    expect(tx.teamInvitation.findFirst).toHaveBeenCalledWith({
      where: { tenantId: admin.tenantId, email: { equals: input.email, mode: 'insensitive' }, acceptedAt: { not: null } }, select: { id: true },
    });
    expect(tx.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      select: { id: true, memberships: { where: { tenantId: admin.tenantId }, select: { id: true } } },
    }));
    expect(tx.userMembership.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: admin.tenantId, userId: 'existing', role: 'editor' }), select: expect.any(Object) });
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.userMembership.update).not.toHaveBeenCalled();
    expect(tx.teamInvitation.create).not.toHaveBeenCalled();
  });

  it('does not offer or permit reactivation without confirmed prior access to this tenant', async () => {
    const { service, tx } = former();
    tx.teamInvitation.findFirst.mockResolvedValue(null);
    for (const operation of [() => service.invite(admin, input), () => service.reactivate(admin, input)]) {
      const error = await operation().catch(error => error);
      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).not.toHaveProperty('errors.reactivationAvailable');
    }
    expect(tx.userMembership.create).not.toHaveBeenCalled();
  });

  it('offers and confirms reactivation of a legacy account using its removal audit in this tenant', async () => {
    const { service, tx } = former();
    tx.teamInvitation.findFirst.mockResolvedValue(null);
    tx.auditLog.findFirst.mockResolvedValue({ id: 'removal-audit' });
    const error = await service.invite(admin, input).catch(error => error);
    expect(error.getResponse()).toMatchObject({ errors: { reactivationAvailable: true } });
    expect(tx.userMembership.create).not.toHaveBeenCalled();
    await service.reactivate(admin, { email: input.email, role: 'editor' });
    expect(tx.auditLog.findFirst).toHaveBeenCalledWith({
      where: { tenantId: admin.tenantId, action: 'team.member_removed', targetType: 'user', targetId: 'existing' },
      select: { id: true },
    });
    expect(tx.userMembership.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'existing', role: 'editor' }) }));
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('rejects a current member and repeated confirmation without changing their role', async () => {
    const { service, tx } = former();
    await service.reactivate(admin, input);
    tx.user.findFirst.mockResolvedValue({ id: 'existing', memberships: [{ id: 'restored' }] });
    await expect(service.reactivate(admin, { ...input, role: 'admin' })).rejects.toMatchObject({ status: 409 });
    const error = await service.invite(admin, input).catch(error => error);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).not.toHaveProperty('errors.reactivationAvailable');
    expect(tx.userMembership.create).toHaveBeenCalledOnce();
    expect(tx.userMembership.update).not.toHaveBeenCalled();
  });

  it('does not silently create a new account when the old account is gone', async () => {
    const { service, tx } = former();
    tx.user.findFirst.mockResolvedValue(null);
    await expect(service.reactivate(admin, input)).rejects.toMatchObject({ status: 404 });
    expect(tx.userMembership.create).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it.each(['ana@other.com', 'ana@sub.example.com'])('enforces the same email-domain rule during confirmation: %s', async email => {
    const { service, tx } = former();
    await expect(service.reactivate(admin, { ...input, email })).rejects.toMatchObject({ status: 403 });
    expect(tx.user.findFirst).not.toHaveBeenCalled();
    expect(tx.userMembership.create).not.toHaveBeenCalled();
  });

  it.each([{ users: 10 }, { users: 9, pending: 1 }, { admins: 3 }, { admins: 2, adminPending: 1 }])('rechecks reserved capacity at confirmation: %j', async options => {
    const { service, tx } = former(options);
    await expect(service.reactivate(admin, { ...input, role: 'admin' })).rejects.toMatchObject({ status: 409 });
    expect(tx.userMembership.create).not.toHaveBeenCalled();
  });

  it('does not restore access to an archived workspace', async () => {
    const { service, tx } = former();
    tx.$queryRaw.mockResolvedValue([]);
    await expect(service.reactivate(admin, input)).rejects.toMatchObject({ status: 404 });
    expect(tx.userMembership.create).not.toHaveBeenCalled();
  });

  it('normalizes the confirmed email, validates roles, and ignores account profile/password fields', () => {
    expect(ReactivateUserSchema.parse({ email: ' ANA@EXAMPLE.COM ', role: 'editor', name: 'Changed', password: 'Changed' })).toEqual({ email: input.email, role: 'editor' });
    expect(ReactivateUserSchema.safeParse({ email: input.email, role: 'owner' }).success).toBe(false);
    expect(ReactivateUserSchema.safeParse({ email: 'not-email', role: 'viewer' }).success).toBe(false);
  });
});

describe('removing team members', () => {
  it('removes only the tenant membership and revokes invitations sent by that member', async () => {
    const { service, tx } = setup();
    await service.removeMember(admin, 'member');
    expect(tx.userMembership.findFirst).toHaveBeenCalledWith({ where: { id: 'member', tenantId: admin.tenantId } });
    expect(tx.userMembership.delete).toHaveBeenCalledWith({ where: { id: 'member', tenantId: admin.tenantId } });
    expect(tx.teamInvitation.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ tenantId: admin.tenantId, invitedByUserId: 'member-user', acceptedAt: null, revokedAt: null }),
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.userMembership.delete.mock.invocationCallOrder[0]).toBeGreaterThan(tx.$queryRaw.mock.invocationCallOrder[0]!);
  });

  it('rejects missing and foreign memberships without changing data', async () => {
    const { service, tx } = setup();
    tx.userMembership.findFirst.mockResolvedValue(null);
    await expect(service.removeMember(admin, 'foreign-member')).rejects.toMatchObject({ status: 404 });
    expect(tx.userMembership.delete).not.toHaveBeenCalled();
    expect(tx.teamInvitation.updateMany).not.toHaveBeenCalled();
  });

  it('prevents removing the current account even if another administrator exists', async () => {
    const { service, tx } = setup({ admins: 2 });
    tx.userMembership.findFirst.mockResolvedValue({ id: 'self', userId: admin.userId, tenantId: admin.tenantId, role: 'admin' });
    await expect(service.removeMember(admin, 'self')).rejects.toMatchObject({ status: 403 });
    expect(tx.userMembership.delete).not.toHaveBeenCalled();
  });

  it.each(['admin', 'owner'])('protects the last %s and permits removal when another remains', async (targetRole) => {
    const { service, tx } = setup({ targetRole });
    await expect(service.removeMember(admin, 'member')).rejects.toMatchObject({ status: 409 });
    expect(tx.userMembership.delete).not.toHaveBeenCalled();
    tx.userMembership.count.mockResolvedValue(2);
    await service.removeMember(admin, 'member');
    expect(tx.userMembership.delete).toHaveBeenCalledOnce();
  });
});

describe('accepting a tenant invitation', () => {
  it('adds a user to the existing tenant and consumes the invite once', async () => {
    const { service, tx, invitation } = setup();
    const result = await service.accept('a'.repeat(64), input.email, input.name, 'long-password');
    expect(result).toMatchObject({ tenantId: admin.tenantId, role: 'viewer', email: input.email });
    expect(tx.userMembership.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: admin.tenantId, role: invitation.role }) });
    expect(tx.user.create).toHaveBeenCalledWith({ data: expect.objectContaining({ passwordHash: 'password-hash' }) });
    await expect(service.accept('a'.repeat(64), input.email, input.name, 'long-password')).rejects.toMatchObject({ status: 403 });
    expect(tx.user.create).toHaveBeenCalledOnce();
  });

  it.each(['expired', 'revoked', 'accepted', 'changed-email', 'invalid-token'])('rejects %s invitations without creating a user', async (state) => {
    const { service, tx, invitation } = setup();
    if (state === 'expired') invitation.expiresAt = new Date(0);
    if (state === 'revoked') invitation.revokedAt = new Date();
    if (state === 'accepted') invitation.acceptedAt = new Date();
    if (state === 'invalid-token') tx.teamInvitation.findUnique.mockResolvedValue(null);
    await expect(service.accept('a'.repeat(64), state === 'changed-email' ? 'other@example.com' : input.email, 'Ana', 'long-password')).rejects.toMatchObject({ status: 403 });
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('rejects an invitation whose inviting administrator was demoted', async () => {
    const { service } = setup({ actorRole: 'editor' });
    await expect(service.accept('a'.repeat(64), input.email, 'Ana', 'long-password')).rejects.toMatchObject({ status: 403 });
  });

  it.each([{ users: 10, role: 'viewer' }, { admins: 3, role: 'admin' }])('rechecks hard limits at acceptance (%j)', async ({ role, ...options }) => {
    const { service, invitation, tx } = setup(options);
    invitation.role = role as 'viewer';
    await expect(service.accept('a'.repeat(64), input.email, 'Ana', 'long-password')).rejects.toMatchObject({ status: 409 });
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('accepts the operator-created initial admin without a preexisting inviter', async () => {
    const { service, invitation } = setup({ users: 0, admins: 0 });
    invitation.invitedByUserId = null;
    invitation.role = 'admin' as 'viewer';
    expect((await service.accept('a'.repeat(64), input.email, 'Ana', 'long-password')).role).toBe('admin');
  });

  it('normalizes invitation email and permits only the three requested roles', () => {
    expect(InviteUserSchema.parse({ name: ' Ana ', email: ' Ana@EXAMPLE.com ' })).toMatchObject({ name: 'Ana', email: input.email, role: 'viewer' });
    expect(InviteUserSchema.safeParse({ ...input, role: 'owner' }).success).toBe(false);
  });
});
