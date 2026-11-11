import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../../common/prisma/prisma.service';
import { newId } from '../../common/crypto/ids';
import { hashInvitationToken } from '../team/invitation';
import type { AppEnv } from '../../config/env';

@Injectable()
export class PasswordResetService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService<AppEnv, true>) {}

  async create(tenantId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.userMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        include: { user: { select: { email: true } }, tenant: { select: { archivedAt: true } } },
      });
      if (!membership || membership.tenant.archivedAt) throw new NotFoundException('Usuário não encontrado em um cliente ativo.');
      // Serialize link replacement and password changes on the account.
      await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;
      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await tx.passwordReset.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
      await tx.passwordReset.create({ data: { id: newId(), userId, tokenHash: hashInvitationToken(token), expiresAt } });
      const url = new URL('/reset-password', this.config.get('DASHBOARD_ORIGIN', { infer: true }).split(',')[0]!.trim());
      url.searchParams.set('email', membership.user.email);
      url.hash = token;
      return { url: url.toString(), expiresAt };
    });
  }

  async complete(token: string, password: string): Promise<void> {
    const tokenHash = hashInvitationToken(token);
    const reset = await this.prisma.passwordReset.findUnique({ where: { tokenHash } });
    if (!reset || reset.usedAt || reset.expiresAt <= new Date()) throw new ForbiddenException('Link inválido ou expirado. Solicite um novo link.');
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${reset.userId} FOR UPDATE`;
      const activeAccount = await tx.userMembership.findFirst({ where: { userId: reset.userId, tenant: { archivedAt: null } } });
      if (!activeAccount) throw new ForbiddenException('A conta não tem acesso a um cliente ativo.');
      const consumed = await tx.passwordReset.updateMany({
        where: { id: reset.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() },
      });
      if (!consumed.count) throw new ForbiddenException('Link inválido ou expirado. Solicite um novo link.');
      await tx.user.update({ where: { id: reset.userId }, data: { passwordHash, sessionVersion: { increment: 1 } } });
    });
  }
}
