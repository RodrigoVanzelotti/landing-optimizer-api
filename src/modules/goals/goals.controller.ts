import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { GoalsService } from './goals.service';
import {
  CreateGoalSchema,
  UpdateGoalSchema,
  type CreateGoalDto,
  type UpdateGoalDto,
} from './goals.dto';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthUser } from '../../common/auth/auth.types';

@Controller('sites/:siteId/goals')
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Post()
  @Roles('editor')
  create(
    @CurrentUser() user: AuthUser,
    @Param('siteId') siteId: string,
    @Body(new ZodValidationPipe(CreateGoalSchema)) dto: CreateGoalDto,
  ) {
    return this.goals.create(user, siteId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('siteId') siteId: string) {
    return this.goals.list(user.tenantId, siteId);
  }

  @Get(':goalId')
  get(
    @CurrentUser() user: AuthUser,
    @Param('siteId') siteId: string,
    @Param('goalId') goalId: string,
  ) {
    return this.goals.get(user.tenantId, siteId, goalId);
  }

  @Patch(':goalId')
  @Roles('editor')
  update(
    @CurrentUser() user: AuthUser,
    @Param('siteId') siteId: string,
    @Param('goalId') goalId: string,
    @Body(new ZodValidationPipe(UpdateGoalSchema)) dto: UpdateGoalDto,
  ) {
    return this.goals.update(user, siteId, goalId, dto);
  }

  @Delete(':goalId')
  @Roles('editor')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('siteId') siteId: string,
    @Param('goalId') goalId: string,
  ): Promise<void> {
    await this.goals.remove(user, siteId, goalId);
  }
}
