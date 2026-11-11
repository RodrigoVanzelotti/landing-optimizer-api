import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AppEnv } from '../../config/env';
import type { AuthUser } from '../../common/auth/auth.types';
import { provisionTenant } from '../team/provision-tenant';
import type { CreateTenantDto } from './platform.dto';

@Injectable()
export class PlatformService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService<AppEnv, true>) {}

  list() {
    return this.prisma.tenant.findMany({
      select: { id: true, name: true, slug: true, plan: true, dataRegion: true, archivedAt: true, createdAt: true, _count: { select: { memberships: true, sites: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id }, select: {
      id: true, name: true, slug: true, plan: true, dataRegion: true, archivedAt: true, createdAt: true,
      memberships: { select: { id: true, role: true, createdAt: true, user: { select: { id: true, name: true, email: true, createdAt: true } } }, orderBy: { createdAt: 'asc' } },
      sites: { select: { id: true, name: true, primaryDomain: true, status: true } },
      invitations: { where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, name: true, email: true, role: true, expiresAt: true } },
    } });
    if (!tenant) throw new NotFoundException('Cliente não encontrado.');
    return tenant;
  }

  create(input: CreateTenantDto) {
    const origin = this.config.get('DASHBOARD_ORIGIN', { infer: true }).split(',')[0]!.trim();
    return provisionTenant(this.prisma, input.tenantName, { name: input.name, email: input.email, role: 'admin' }, origin);
  }

  async archive(user: AuthUser, id: string, confirmation: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tenant WHERE id = ${id} FOR UPDATE`;
      const tenant = await tx.tenant.findUnique({ where: { id } });
      if (!tenant) throw new NotFoundException('Cliente não encontrado.');
      if (tenant.name !== confirmation) throw new ConflictException('Digite o nome exato do cliente para confirmar.');
      if (id === user.tenantId || await tx.userMembership.findFirst({ where: { tenantId: id, userId: user.userId } })) throw new ConflictException('Você não pode arquivar um cliente ao qual sua própria conta pertence.');
      await tx.tenant.update({ where: { id }, data: { archivedAt: new Date() } });
    });
  }

  async restore(id: string): Promise<void> {
    await this.prisma.tenant.update({ where: { id }, data: { archivedAt: null } });
  }
}
