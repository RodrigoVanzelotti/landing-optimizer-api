import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { newId } from '../crypto/ids';

export interface AuditEntry {
  tenantId: string;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  ipHash?: string | null;
}

/**
 * Append-only audit trail. Metadata must never contain PII — callers pass only
 * before/after summaries and identifiers.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        id: newId(),
        tenantId: entry.tenantId,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: (entry.metadata ?? {}) as object,
        ipHash: entry.ipHash ?? null,
      },
    });
  }

  async list(
    tenantId: string,
    opts: { action?: string; limit?: number } = {},
  ): Promise<unknown[]> {
    return this.prisma.auditLog.findMany({
      where: { tenantId, ...(opts.action ? { action: opts.action } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.limit ?? 100, 500),
    });
  }
}

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
