import { ForbiddenException, Global, Injectable, Module, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { newId } from '../crypto/ids';
import type { AuthUser } from '../auth/auth.types';
import { isAdmin } from '../../modules/team/invitation';
import { auditRange, type AuditQuery } from './audit.query';

export interface AuditEntry {
  tenantId: string;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  ipHash?: string | null;
}

/** Use the mutation's transaction so an audit failure rolls back the change. */
export async function writeAudit(client: Pick<Prisma.TransactionClient, 'auditLog'>, entry: AuditEntry): Promise<void> {
  await client.auditLog.create({ data: {
    id: newId(), tenantId: entry.tenantId, actorUserId: entry.actorUserId ?? null,
    action: entry.action, targetType: entry.targetType, targetId: entry.targetId,
    metadata: (entry.metadata ?? {}) as object, ipHash: entry.ipHash ?? null,
  } });
}

/**
 * Append-only audit trail. Metadata must never contain PII — callers pass only
 * before/after summaries and identifiers.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry, tx: Prisma.TransactionClient = this.prisma): Promise<void> {
    await writeAudit(tx, entry);
  }

  async listLegacy(tenantId: string, action?: string) {
    return this.prisma.auditLog.findMany({
      where: { tenantId, ...(action ? { action } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
      select: { id: true, action: true, targetType: true, targetId: true, createdAt: true },
    });
  }

  async options(user: AuthUser) {
    const memberships = await this.prisma.userMembership.findMany({
      where: { tenantId: user.tenantId }, select: { userId: true, user: { select: { id: true, name: true, email: true } } },
    });
    const actors = new Map(memberships.map(member => [member.userId, { ...member.user, former: false }]));
    if (isAdmin(user.role)) {
      const history = await this.prisma.auditLog.groupBy({ by: ['actorUserId'], where: { tenantId: user.tenantId, actorUserId: { not: null } } });
      const ids = history.map(row => row.actorUserId!).filter(id => !actors.has(id));
      const former = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : [];
      for (const account of former) actors.set(account.id, { ...account, former: true });
      for (const id of ids) if (!actors.has(id)) actors.set(id, { id, name: 'Conta indisponível', email: '', former: true });
    }
    const actions = await this.prisma.auditLog.groupBy({ by: ['action'], where: { tenantId: user.tenantId }, orderBy: { action: 'asc' } });
    return { authors: [...actors.values()].sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email)), actions: actions.map(row => row.action) };
  }

  async list(user: AuthUser, query: AuditQuery) {
    const range = auditRange(query.timeframe);
    const admin = isAdmin(user.role);
    if (query.actorUserId && query.actorUserId !== 'system' && !admin) {
      const current = await this.prisma.userMembership.findFirst({ where: { tenantId: user.tenantId, userId: query.actorUserId }, select: { id: true } });
      if (!current) throw new ForbiddenException('Somente administradores podem consultar autores fora da equipe atual.');
    }
    const where: Prisma.AuditLogWhereInput = {
      tenantId: user.tenantId, createdAt: { gte: range.from, lte: range.to },
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId === 'system' ? null : query.actorUserId } : {}),
    };
    if (query.cursor && !await this.prisma.auditLog.findFirst({ where: { ...where, id: query.cursor }, select: { id: true } })) throw new NotFoundException('Página não encontrada para estes filtros. Consulte novamente.');
    const rows = await this.prisma.auditLog.findMany({
      where, orderBy: [{ createdAt: query.order }, { id: query.order }], take: 26,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: { id: true, actorUserId: true, action: true, targetType: true, targetId: true, createdAt: true },
    });
    const page = rows.slice(0, 25);
    const ids = [...new Set(page.flatMap(row => [...(row.actorUserId ? [row.actorUserId] : []), ...(row.targetType === 'user' ? [row.targetId] : [])]))];
    const current = ids.length ? await this.prisma.userMembership.findMany({ where: { tenantId: user.tenantId, userId: { in: ids } }, select: { userId: true } }) : [];
    const activeIds = new Set(current.map(member => member.userId));
    const visibleIds = admin ? ids : ids.filter(id => activeIds.has(id));
    const accounts = visibleIds.length ? await this.prisma.user.findMany({ where: { id: { in: visibleIds } }, select: { id: true, name: true, email: true } }) : [];
    const byId = new Map(accounts.map(account => [account.id, account]));
    const siteIds = page.filter(row => row.targetType === 'site').map(row => row.targetId);
    const sites = siteIds.length ? await this.prisma.site.findMany({ where: { tenantId: user.tenantId, id: { in: siteIds } }, select: { id: true, name: true } }) : [];
    const siteNames = new Map(sites.map(site => [site.id, site.name]));
    return {
      items: page.map(({ actorUserId, ...row }) => ({ ...row,
        targetLabel: row.targetType === 'user' ? byId.get(row.targetId)?.name ?? byId.get(row.targetId)?.email ?? null : siteNames.get(row.targetId) ?? null,
        actor: !actorUserId ? { kind: 'system' as const } : !admin && !activeIds.has(actorUserId) ? { kind: 'restricted' as const } : {
          kind: 'user' as const, id: actorUserId, name: byId.get(actorUserId)?.name ?? null,
          email: byId.get(actorUserId)?.email ?? null, former: !activeIds.has(actorUserId),
        },
      })),
      nextCursor: rows.length > 25 ? page[page.length - 1]!.id : null,
      range,
    };
  }
}

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
