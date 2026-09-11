import { Controller, Get, Param } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { JourneyService } from './journey.service';

/** Activation journey read model for the dashboard (any authenticated role). */
@Controller('sites/:siteId/journey')
export class JourneyController {
  constructor(private readonly journey: JourneyService) {}

  @Get()
  get(@CurrentUser() user: AuthUser, @Param('siteId') siteId: string) {
    return this.journey.get(user.tenantId, siteId);
  }
}
