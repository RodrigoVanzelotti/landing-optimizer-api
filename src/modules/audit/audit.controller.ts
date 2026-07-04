import { Controller, Get, Module, Query } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.module';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/auth.types';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('action') action?: string) {
    return this.audit.list(user.tenantId, { action });
  }
}

@Module({
  controllers: [AuditController],
})
export class AuditReadModule {}
