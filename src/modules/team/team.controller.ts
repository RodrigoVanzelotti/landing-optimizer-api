import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ChangeRoleSchema, InviteUserSchema, type InviteUserDto } from './team.dto';
import { TeamService } from './team.service';

@Controller('team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  @Roles('editor')
  list(@CurrentUser() user: AuthUser) { return this.team.list(user); }

  @Post('invitations')
  @Roles('admin')
  invite(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(InviteUserSchema)) dto: InviteUserDto) {
    return this.team.invite(user, dto);
  }

  @Delete('invitations/:id')
  @Roles('admin')
  @HttpCode(204)
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.team.revoke(user, id); }

  @Patch('members/:id/role')
  @Roles('admin')
  changeRole(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodValidationPipe(ChangeRoleSchema)) dto: { role: 'admin' | 'editor' | 'viewer' }) {
    return this.team.changeRole(user, id, dto.role);
  }
}
