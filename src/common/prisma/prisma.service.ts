import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Logger } from '../logging/logger';

const logger = Logger('PrismaService');

/**
 * Prisma client wrapper with an explicit tenant transaction helper.
 * Services currently enforce tenant ownership; migrations do not enable RLS.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit(): Promise<void> {
    await this.$connect();
    logger.info('dependency_connected', { dependency: 'postgresql' });
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
