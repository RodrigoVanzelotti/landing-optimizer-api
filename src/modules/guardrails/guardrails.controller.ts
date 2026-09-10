import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { GuardrailsService } from './guardrails.service';
import { PutGuardrailSchema, type PutGuardrailDto } from './guardrails.dto';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthUser } from '../../common/auth/auth.types';

@Controller('sites/:siteId/guardrails')
export class GuardrailsController {
  constructor(private readonly guardrails: GuardrailsService) {}

  @Get()
  get(@CurrentUser() user: AuthUser, @Param('siteId') siteId: string) {
    return this.guardrails.get(user.tenantId, siteId);
  }

  @Put()
  @Roles('editor')
  put(
    @CurrentUser() user: AuthUser,
    @Param('siteId') siteId: string,
    @Body(new ZodValidationPipe(PutGuardrailSchema)) dto: PutGuardrailDto,
  ) {
    return this.guardrails.put(user, siteId, dto.rules);
  }
}
