import { Controller, Get, Param, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { ExperimentReportService } from './experiment-report.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AnalyticsRangeQuerySchema, SiteQuerySchema, ReportQuerySchema, type AnalyticsRangeQuery, type ReportQuery } from './report';
import { ExperimentImpactQuerySchema, type ExperimentImpactQuery } from './experiment-impact';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService, private readonly reports: ExperimentReportService) {}

  @Get('experiments/:id/report')
  experimentReport(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.reports.report(user.tenantId, id);
  }

  @Get('experiment-impact')
  experimentImpact(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(ExperimentImpactQuerySchema)) query: ExperimentImpactQuery) {
    return this.analytics.experimentImpact(user.tenantId, query);
  }

  @Get('report')
  report(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(ReportQuerySchema)) query: ReportQuery) {
    return this.analytics.report(user.tenantId, query.siteId, query.timeframe);
  }

  @Get('overview')
  overview(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(AnalyticsRangeQuerySchema)) query: AnalyticsRangeQuery,
  ) {
    return this.analytics.overview(user.tenantId, query.siteId, fmt(query.from), fmt(query.to));
  }

  @Get('funnel')
  funnel(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(SiteQuerySchema)) query: { siteId: string }) {
    return this.analytics.funnel(user.tenantId, query.siteId);
  }

  @Get('sections')
  sections(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(SiteQuerySchema)) query: { siteId: string }) {
    return this.analytics.sections(user.tenantId, query.siteId);
  }

  @Get('heatmap')
  heatmap(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(AnalyticsRangeQuerySchema)) query: AnalyticsRangeQuery,
  ) {
    return this.analytics.heatmap(
      user.tenantId,
      query.siteId,
      query.path || '/',
      fmt(query.from),
      fmt(query.to),
    );
  }

  @Get('experiments/:id/results')
  async results(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const report = await this.reports.report(user.tenantId, id);
    return { experimentId: id, variants: report.variants };
  }

  @Get('experiments/results')
  siteResults(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(SiteQuerySchema)) query: { siteId: string }) {
    return this.analytics.siteExperimentResults(user.tenantId, query.siteId);
  }
}

/** Convert an ISO timestamp to ClickHouse DateTime64 literal. */
function fmt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace('Z', '');
}
