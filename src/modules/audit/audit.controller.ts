import { Controller, Get, Module, Query } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.module';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { AuditQuerySchema, LegacyAuditQuerySchema, type AuditQuery } from '../../common/audit/audit.query';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(LegacyAuditQuerySchema)) query: Pick<AuditQuery, 'action'>) {
    return this.audit.listLegacy(user.tenantId, query.action);
  }

  @Get('search')
  search(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(AuditQuerySchema)) query: AuditQuery) {
    return this.audit.list(user, query);
  }

  @Get('options')
  options(@CurrentUser() user: AuthUser) { return this.audit.options(user); }
}

@Module({
  controllers: [AuditController],
})
export class AuditReadModule {}
