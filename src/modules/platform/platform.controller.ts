import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { PlatformOwnerGuard } from '../../common/auth/platform-owner.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PasswordResetService } from '../auth/password-reset.service';
import { ArchiveTenantSchema, CreateTenantSchema, type CreateTenantDto } from './platform.dto';
import { PlatformService } from './platform.service';

@Controller('platform/tenants')
@Roles('viewer')
@UseGuards(PlatformOwnerGuard)
export class PlatformController {
  constructor(private readonly platform: PlatformService, private readonly passwords: PasswordResetService) {}

  @Get()
  list() { return this.platform.list(); }

  @Get(':id')
  get(@Param('id') id: string) { return this.platform.get(id); }

  @Post()
  create(@Body(new ZodValidationPipe(CreateTenantSchema)) dto: CreateTenantDto) { return this.platform.create(dto); }

  @Post(':id/users/:userId/password-reset')
  resetPassword(@Param('id') id: string, @Param('userId') userId: string) { return this.passwords.create(id, userId); }

  @Post(':id/archive')
  @HttpCode(204)
  archive(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodValidationPipe(ArchiveTenantSchema)) dto: { confirmation: string }) {
    return this.platform.archive(user, id, dto.confirmation);
  }

  @Post(':id/restore')
  @HttpCode(204)
  restore(@Param('id') id: string) { return this.platform.restore(id); }
}
