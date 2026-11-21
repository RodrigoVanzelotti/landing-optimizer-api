import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AiService } from './ai.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';

const InsightQuerySchema = z.object({ insightId: z.string().uuid().optional() });

@Controller()
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('sites/:id/ai/suggestions')
  suggestions(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query(new ZodValidationPipe(InsightQuerySchema)) query: { insightId?: string }) {
    return this.ai.listSuggestions(user.tenantId, id, query.insightId);
  }

  @Post('ai/suggestions/:id/approve')
  @Roles('editor')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ai.approve(user, id);
  }
}
