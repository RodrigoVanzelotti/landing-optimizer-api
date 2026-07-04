import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Prisma client wrapper. Sets the per-request `app.tenant_id` GUC used by
 * PostgreSQL Row-Level Security policies (see docs/SECURITY.md §2).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run a callback inside a transaction with the tenant GUC set so RLS applies.
   * Use for any tenant-scoped write path that must be enforced at the DB layer.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.tenant_id', $1, true)`,
        tenantId,
      );
      return fn(tx);
    });
  }
}
