import { Controller, Get, Param, Post } from '@nestjs/common';
import { AiService } from './ai.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthUser } from '../../common/auth/auth.types';

@Controller()
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('sites/:id/ai/analyze')
  @Roles('editor')
  analyze(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ai.analyze(user, id);
  }

  @Get('sites/:id/ai/suggestions')
  suggestions(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ai.listSuggestions(user.tenantId, id);
  }

  @Post('ai/suggestions/:id/materialize')
  @Roles('editor')
  materialize(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ai.materialize(user, id);
  }
}
