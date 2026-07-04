import {
  ForbiddenException,
  Injectable,
  Module,
  NotFoundException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import type { ApprovalStatus } from '@prisma/client';

@Injectable()
export class ApprovalsService {
  constructor(private readonly prisma: PrismaService) {}

  async listQueue(tenantId: string, status?: ApprovalStatus): Promise<unknown[]> {
    return this.prisma.approval.findMany({
      where: {
        status: status ?? 'pending',
        experiment: { tenantId },
      },
      include: {
        experiment: {
          include: { variants: { include: { changes: true } }, site: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async get(tenantId: string, id: string): Promise<unknown> {
    const approval = await this.prisma.approval.findUnique({
      where: { id },
      include: {
        experiment: { include: { variants: { include: { changes: true } } } },
      },
    });
    if (!approval) throw new NotFoundException('Approval not found');
    if (approval.experiment.tenantId !== tenantId) {
      throw new ForbiddenException('Cross-tenant access');
    }
    return approval;
  }
}

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('status') status?: ApprovalStatus) {
    return this.approvals.listQueue(user.tenantId, status);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.approvals.get(user.tenantId, id);
  }
}

@Module({
  providers: [ApprovalsService],
  controllers: [ApprovalsController],
})
export class ApprovalsModule {}
