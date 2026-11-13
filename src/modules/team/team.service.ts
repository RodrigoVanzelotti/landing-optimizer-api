import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../../common/prisma/prisma.service';
import { newId } from '../../common/crypto/ids';
import type { AuthUser } from '../../common/auth/auth.types';
import type { AppEnv } from '../../config/env';
import type { InviteUserDto, ReactivateUserDto } from './team.dto';
import { ADMIN_LIMIT, USER_LIMIT, emailDomain, hashInvitationToken, isAdmin, newInvitation } from './invitation';
import { writeAudit } from '../../common/audit/audit.module';
import { isPlatformOwner } from '../../common/auth/platform-owner.guard';

const active = () => ({ acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } });
const memberSelect = { id: true, role: true, createdAt: true, user: { select: { id: true, name: true, email: true } } } as const;
const inviteSelect = { id: true, name: true, email: true, role: true, expiresAt: true } as const;

@Injectable()
export class TeamService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService<AppEnv, true>) {}

  async list(user: AuthUser) {
    const [members, invitations] = await Promise.all([
      this.prisma.userMembership.findMany({ where: { tenantId: user.tenantId }, select: memberSelect, orderBy: { createdAt: 'asc' } }),
      this.prisma.teamInvitation.findMany({ where: { tenantId: user.tenantId, ...active() }, select: inviteSelect, orderBy: { createdAt: 'desc' } }),
    ]);
    return { members, invitations, domain: emailDomain(user.email), userLimit: USER_LIMIT, adminLimit: ADMIN_LIMIT };
  }

  private async lock(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
    // Serialize membership changes and invitations to preserve capacity and the last administrator.
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tenant WHERE id = ${tenantId} AND archived_at IS NULL FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Tenant not found');
  }

  private async requireAdmin(tx: Prisma.TransactionClient, user: Pick<AuthUser, 'userId' | 'tenantId'>): Promise<string> {
    const membership = await tx.userMembership.findUnique({ where: { tenantId_userId: { tenantId: user.tenantId, userId: user.userId } }, include: { user: { select: { email: true } } } });
    if (!membership || !isAdmin(membership.role)) throw new ForbiddenException('Only administrators can manage the team');
    return membership.user.email;
  }

  private async capacity(tx: Prisma.TransactionClient, tenantId: string, role: string, addingUser: boolean): Promise<void> {
    const [users, invitations, admins, adminInvitations] = await Promise.all([
      tx.userMembership.count({ where: { tenantId } }),
      tx.teamInvitation.count({ where: { tenantId, ...active() } }),
      tx.userMembership.count({ where: { tenantId, role: { in: ['admin', 'owner'] } } }),
      tx.teamInvitation.count({ where: { tenantId, role: 'admin', ...active() } }),
    ]);
    if (addingUser && users + invitations >= USER_LIMIT) throw new ConflictException('Limite de 10 usuários atingido, incluindo convites pendentes.');
    if (isAdmin(role) && admins + adminInvitations >= ADMIN_LIMIT) throw new ConflictException('Limite de 3 administradores atingido, incluindo convites pendentes.');
  }

  async invite(user: AuthUser, input: InviteUserDto) {
    if (isPlatformOwner(input.email)) throw new ForbiddenException('The platform account can only be provisioned by the operator');
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, user.tenantId);
      const adminEmail = await this.requireAdmin(tx, user);
      if (emailDomain(input.email) !== emailDomain(adminEmail)) throw new ForbiddenException('Convide apenas pessoas com o mesmo domínio de e-mail que o seu.');
      if (await this.formerMember(tx, user.tenantId, input.email)) throw new ConflictException({
        message: 'Esta conta foi preservada. Deseja reativar o acesso a este workspace?',
        errors: { reactivationAvailable: true },
      });
      if (await tx.teamInvitation.findFirst({ where: { tenantId: user.tenantId, email: input.email, ...active() } })) throw new ConflictException('Já existe um convite pendente para este e-mail.');
      await this.capacity(tx, user.tenantId, input.role, true);
      const origin = this.config.get('DASHBOARD_ORIGIN', { infer: true }).split(',')[0]!.trim();
      const { data, url } = newInvitation(user.tenantId, input, origin, user.userId);
      const invitation = await tx.teamInvitation.create({ data, select: inviteSelect });
      await writeAudit(tx, { tenantId: user.tenantId, actorUserId: user.userId, action: 'team.invited', targetType: 'team_invitation', targetId: invitation.id, metadata: { role: input.role } });
      return { ...invitation, url };
    });
  }

  private async formerMember(tx: Prisma.TransactionClient, tenantId: string, email: string) {
    const account = await tx.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, memberships: { where: { tenantId }, select: { id: true } } },
    });
    if (!account) return null;
    if (account.memberships.length) throw new ConflictException('Esta pessoa já faz parte deste workspace.');
    // Legacy accounts may predate invitations; removal audits also prove prior tenant access.
    const priorAccess = await tx.teamInvitation.findFirst({
      where: { tenantId, email: { equals: email, mode: 'insensitive' }, acceptedAt: { not: null } },
      select: { id: true },
    });
    const removed = !priorAccess && await tx.auditLog.findFirst({
      where: { tenantId, action: 'team.member_removed', targetType: 'user', targetId: account.id },
      select: { id: true },
    });
    if (!priorAccess && !removed) throw new ConflictException('Este e-mail já tem uma conta. Não há vínculo anterior confirmado com este workspace.');
    return account;
  }

  async reactivate(user: AuthUser, input: ReactivateUserDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, user.tenantId);
      const adminEmail = await this.requireAdmin(tx, user);
      if (emailDomain(input.email) !== emailDomain(adminEmail)) throw new ForbiddenException('Reative apenas pessoas com o mesmo domínio de e-mail que o seu.');
      const account = await this.formerMember(tx, user.tenantId, input.email);
      if (!account) throw new NotFoundException('Conta não encontrada. Gere um novo convite para este e-mail.');
      await this.capacity(tx, user.tenantId, input.role, true);
      const member = await tx.userMembership.create({ data: { id: newId(), tenantId: user.tenantId, userId: account.id, role: input.role }, select: memberSelect });
      await writeAudit(tx, { tenantId: user.tenantId, actorUserId: user.userId, action: 'team.member_reactivated', targetType: 'user', targetId: account.id, metadata: { role: input.role } });
      return member;
    });
  }

  async revoke(user: AuthUser, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, user.tenantId);
      await this.requireAdmin(tx, user);
      const result = await tx.teamInvitation.updateMany({ where: { id, tenantId: user.tenantId, ...active() }, data: { revokedAt: new Date() } });
      if (!result.count) throw new NotFoundException('Convite não encontrado ou já encerrado.');
      await writeAudit(tx, { tenantId: user.tenantId, actorUserId: user.userId, action: 'team.invitation_revoked', targetType: 'team_invitation', targetId: id });
    });
  }

  async changeRole(user: AuthUser, membershipId: string, role: 'admin' | 'editor' | 'viewer') {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, user.tenantId);
      await this.requireAdmin(tx, user);
      const target = await tx.userMembership.findFirst({ where: { id: membershipId, tenantId: user.tenantId } });
      if (!target) throw new NotFoundException('Usuário não encontrado neste cliente.');
      if (isAdmin(target.role) && !isAdmin(role)) {
        const admins = await tx.userMembership.count({ where: { tenantId: user.tenantId, role: { in: ['admin', 'owner'] } } });
        if (admins <= 1) throw new ConflictException('O cliente precisa manter pelo menos um administrador.');
      }
      if (!isAdmin(target.role) && isAdmin(role)) await this.capacity(tx, user.tenantId, role, false);
      const member = await tx.userMembership.update({ where: { id: target.id }, data: { role }, select: memberSelect });
      await writeAudit(tx, { tenantId: user.tenantId, actorUserId: user.userId, action: 'team.role_changed', targetType: 'user', targetId: target.userId, metadata: { before: target.role, after: role } });
      return member;
    });
  }

  async removeMember(user: AuthUser, membershipId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, user.tenantId);
      await this.requireAdmin(tx, user);
      const target = await tx.userMembership.findFirst({ where: { id: membershipId, tenantId: user.tenantId } });
      if (!target) throw new NotFoundException('Usuário não encontrado neste cliente.');
      if (target.userId === user.userId) throw new ForbiddenException('Você não pode remover seu próprio acesso.');
      if (isAdmin(target.role)) {
        const admins = await tx.userMembership.count({ where: { tenantId: user.tenantId, role: { in: ['admin', 'owner'] } } });
        if (admins <= 1) throw new ConflictException('O cliente precisa manter pelo menos um administrador.');
      }
      const invitations = await tx.teamInvitation.findMany({ where: { tenantId: user.tenantId, invitedByUserId: target.userId, ...active() }, select: { id: true } });
      await tx.teamInvitation.updateMany({ where: { tenantId: user.tenantId, invitedByUserId: target.userId, ...active() }, data: { revokedAt: new Date() } });
      for (const invitation of invitations) await writeAudit(tx, { tenantId: user.tenantId, actorUserId: user.userId, action: 'team.invitation_revoked', targetType: 'team_invitation', targetId: invitation.id, metadata: { cause: 'member_removed', removedUserId: target.userId } });
      await tx.user.updateMany({ where: { id: target.userId }, data: { sessionVersion: { increment: 1 } } });
      await tx.userMembership.delete({ where: { id: target.id, tenantId: user.tenantId } });
      await writeAudit(tx, { tenantId: user.tenantId, actorUserId: user.userId, action: 'team.member_removed', targetType: 'user', targetId: target.userId, metadata: { membershipId: target.id, role: target.role } });
    });
  }

  async accept(token: string, email: string, name: string, password: string): Promise<AuthUser> {
    const tokenHash = hashInvitationToken(token);
    const invitation = await this.prisma.teamInvitation.findUnique({ where: { tokenHash } });
    if (!invitation) throw new ForbiddenException('Convite inválido ou expirado.');
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, invitation.tenantId);
      const current = await tx.teamInvitation.findFirst({ where: { id: invitation.id, email, ...active() } });
      if (!current || !['admin', 'editor', 'viewer'].includes(current.role)) throw new ForbiddenException('Convite inválido ou expirado.');
      if (current.invitedByUserId && isPlatformOwner(email)) throw new ForbiddenException('The platform account can only be provisioned by the operator');
      if (current.invitedByUserId) {
        const adminEmail = await this.requireAdmin(tx, { tenantId: current.tenantId, userId: current.invitedByUserId });
        if (emailDomain(email) !== emailDomain(adminEmail)) throw new ForbiddenException('O domínio deste convite não é autorizado.');
      }
      if (await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })) throw new ConflictException('Este e-mail já tem uma conta.');
      const users = await tx.userMembership.count({ where: { tenantId: current.tenantId } });
      const admins = await tx.userMembership.count({ where: { tenantId: current.tenantId, role: { in: ['admin', 'owner'] } } });
      if (users >= USER_LIMIT || (isAdmin(current.role) && admins >= ADMIN_LIMIT)) throw new ConflictException('O limite de usuários ou administradores foi atingido.');
      const userId = newId();
      await tx.user.create({ data: { id: userId, email, name, passwordHash } });
      await tx.userMembership.create({ data: { id: newId(), tenantId: current.tenantId, userId, role: current.role } });
      await tx.teamInvitation.update({ where: { id: current.id }, data: { acceptedAt: new Date() } });
      await writeAudit(tx, { tenantId: current.tenantId, actorUserId: current.invitedByUserId ?? userId, action: 'team.member_added', targetType: 'user', targetId: userId, metadata: { invitationId: current.id, acceptedByUserId: userId, role: current.role } });
      await writeAudit(tx, { tenantId: current.tenantId, actorUserId: userId, action: 'team.invitation_accepted', targetType: 'team_invitation', targetId: current.id });
      return { userId, tenantId: current.tenantId, email, role: current.role };
    });
  }
}
