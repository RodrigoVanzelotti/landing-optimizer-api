import { Controller, Get, Param, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/auth.types';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview(
    @CurrentUser() user: AuthUser,
    @Query('siteId') siteId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const now = new Date();
    const fromDate = from ?? new Date(now.getTime() - 30 * 864e5).toISOString();
    const toDate = to ?? now.toISOString();
    return this.analytics.overview(user.tenantId, siteId, fmt(fromDate), fmt(toDate));
  }

  @Get('funnel')
  funnel(@CurrentUser() user: AuthUser, @Query('siteId') siteId: string) {
    return this.analytics.funnel(user.tenantId, siteId);
  }

  @Get('sections')
  sections(@CurrentUser() user: AuthUser, @Query('siteId') siteId: string) {
    return this.analytics.sections(user.tenantId, siteId);
  }

  @Get('experiments/:id/results')
  results(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.analytics.experimentResults(user.tenantId, id);
  }
}

/** Convert an ISO timestamp to ClickHouse DateTime64 literal. */
function fmt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace('Z', '');
}
