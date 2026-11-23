import { Global, Module } from '@nestjs/common';
import { ClickHouseService } from './clickhouse/clickhouse.service';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { ExperimentReportService } from './experiment-report.service';

@Global()
@Module({
  providers: [ClickHouseService, AnalyticsService, ExperimentReportService],
  controllers: [AnalyticsController],
  exports: [ClickHouseService, AnalyticsService, ExperimentReportService],
})
export class AnalyticsModule {}
