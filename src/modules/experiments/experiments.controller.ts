import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ExperimentStatus } from '@prisma/client';
import { ExperimentsService } from './experiments.service';
import {
  ApproveSchema,
  CompleteSchema,
  CreateExperimentSchema,
  RejectSchema,
  ScheduleSchema,
  UpdateExperimentSchema,
  type ApproveDto,
  type CompleteDto,
  type CreateExperimentDto,
  type RejectDto,
  type ScheduleDto,
  type UpdateExperimentDto,
} from './experiments.dto';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthUser } from '../../common/auth/auth.types';

@Controller('experiments')
export class ExperimentsController {
  constructor(private readonly experiments: ExperimentsService) {}

  @Post()
  @Roles('editor')
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateExperimentSchema)) dto: CreateExperimentDto,
  ) {
    return this.experiments.create(user, dto);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('siteId') siteId?: string,
    @Query('status') status?: ExperimentStatus,
  ) {
    return this.experiments.list(user.tenantId, { siteId, status });
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.experiments.get(user.tenantId, id);
  }

  @Patch(':id')
  @Roles('editor')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateExperimentSchema)) dto: UpdateExperimentDto,
  ) {
    return this.experiments.update(user.tenantId, id, dto);
  }

  @Post(':id/submit')
  @Roles('editor')
  submit(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.experiments.submit(user, id);
  }

  @Post(':id/approve')
  @Roles('admin')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ApproveSchema)) dto: ApproveDto,
  ) {
    return this.experiments.approve(user, id, dto);
  }

  @Post(':id/reject')
  @Roles('admin')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RejectSchema)) dto: RejectDto,
  ) {
    return this.experiments.reject(user, id, dto);
  }

  @Post(':id/schedule')
  @Roles('editor')
  schedule(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ScheduleSchema)) dto: ScheduleDto,
  ) {
    return this.experiments.schedule(user, id, dto);
  }

  @Post(':id/start')
  @Roles('editor')
  start(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.experiments.start(user, id);
  }

  @Post(':id/pause')
  @Roles('editor')
  pause(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.experiments.pause(user, id);
  }

  @Post(':id/complete')
  @Roles('editor')
  complete(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CompleteSchema)) dto: CompleteDto,
  ) {
    return this.experiments.complete(user, id, dto);
  }

  @Post(':id/rollback')
  @Roles('editor')
  rollback(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.experiments.rollback(user, id);
  }

  @Post(':id/kill')
  @Roles('editor')
  kill(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.experiments.kill(user, id);
  }
}
